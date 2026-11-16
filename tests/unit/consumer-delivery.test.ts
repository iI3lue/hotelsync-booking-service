import {
  MAX_DELIVERY_ATTEMPTS,
  handleDelivery,
  retryDelay,
  retryCount,
} from "../../src/lib/consumer-delivery.js";

const QUEUE = "test.queue";
const DLQ = "test.queue.dlq";

function makeChannel() {
  return {
    ack: jest.fn(),
    nack: jest.fn(),
    sendToQueue: jest.fn(
      (
        _queue: string,
        _content: Buffer,
        _options: unknown,
        callback?: (error: unknown) => void
      ) => {
        callback?.(null);
        return true;
      }
    ),
  };
}

function makeMessage(retries = 0, content = JSON.stringify({ booking_id: "b-1" })) {
  return {
    fields: { routingKey: "booking.confirmed" },
    properties: {
      contentType: "application/json",
      messageId: "msg-1",
      headers: retries > 0 ? { "x-retry-count": retries } : {},
    },
    content: Buffer.from(content),
  } as any;
}

function makeLogger() {
  return { error: jest.fn(), warn: jest.fn() };
}

describe("consumer delivery policy", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("acks when the handler succeeds", async () => {
    const channel = makeChannel();
    const handler = jest.fn().mockResolvedValue(undefined);

    await handleDelivery(channel, QUEUE, DLQ, handler, makeMessage(), makeLogger());

    expect(handler).toHaveBeenCalledWith("booking.confirmed", { booking_id: "b-1" });
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("republishes with backoff and an incremented retry counter instead of requeueing", async () => {
    const channel = makeChannel();
    const handler = jest.fn().mockRejectedValue(new Error("upstream down"));
    const log = makeLogger();

    await handleDelivery(channel, QUEUE, DLQ, handler, makeMessage(), log);
    expect(channel.sendToQueue).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1999);
    expect(channel.sendToQueue).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue.mock.calls[0][0]).toBe(QUEUE);
    expect(channel.sendToQueue.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        persistent: true,
        headers: expect.objectContaining({
          "x-retry-count": 1,
          "x-last-error": "upstream down",
        }),
      })
    );
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("grows the delay between attempts", async () => {
    const channel = makeChannel();
    const handler = jest.fn().mockRejectedValue(new Error("upstream down"));

    await handleDelivery(channel, QUEUE, DLQ, handler, makeMessage(1), makeLogger());
    await jest.advanceTimersByTimeAsync(14999);
    expect(channel.sendToQueue).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue.mock.calls[0][2]).toEqual(
      expect.objectContaining({ headers: expect.objectContaining({ "x-retry-count": 2 }) })
    );
  });

  it("dead-letters after the retry budget is exhausted", async () => {
    const channel = makeChannel();
    const handler = jest.fn().mockRejectedValue(new Error("upstream down"));

    await handleDelivery(
      channel,
      QUEUE,
      DLQ,
      handler,
      makeMessage(MAX_DELIVERY_ATTEMPTS),
      makeLogger()
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue.mock.calls[0][0]).toBe(DLQ);
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("acks unparseable payloads without retrying", async () => {
    const channel = makeChannel();
    const handler = jest.fn();

    await handleDelivery(channel, QUEUE, DLQ, handler, makeMessage(0, "not-json"), makeLogger());

    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it("requeues only when the republish itself fails", async () => {
    const channel = makeChannel();
    channel.sendToQueue.mockImplementationOnce(
      (_q: string, _c: Buffer, _o: unknown, callback?: (error: unknown) => void) => {
        callback?.(new Error("channel closed"));
        return false;
      }
    );
    const handler = jest.fn().mockRejectedValue(new Error("upstream down"));

    await handleDelivery(
      channel,
      QUEUE,
      DLQ,
      handler,
      makeMessage(MAX_DELIVERY_ATTEMPTS),
      makeLogger()
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it("caps the retry counter and delay", () => {
    expect(retryCount(makeMessage(2))).toBe(2);
    expect(retryCount(makeMessage(0))).toBe(0);
    expect(retryCount({ properties: { headers: { "x-retry-count": "x" } } } as any)).toBe(0);
    expect(retryDelay(0)).toBe(2000);
    expect(retryDelay(1)).toBe(15000);
    expect(retryDelay(99)).toBe(60000);
  });
});
