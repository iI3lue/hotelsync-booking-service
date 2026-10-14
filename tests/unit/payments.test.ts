import { bookingService } from "../../src/services/booking.service.js";
import { handlePaymentMessage } from "../../src/lib/consumer.js";
import { AppError } from "../../src/middleware/error-handler.js";

jest.mock("../../src/lib/prisma.js", () => ({
  __esModule: true,
  default: {
    booking: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    eventOutbox: { create: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    inventoryReservationAttempt: { upsert: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../src/lib/events.js", () => ({ publishEvent: jest.fn() }));
jest.mock("../../src/lib/rate-client.js", () => ({
  reserveInventory: jest.fn(),
  releaseInventory: jest.fn(),
}));
// El consumidor importa el broker; en tests nunca se conecta.
jest.mock("../../src/lib/broker.js", () => ({ broker: { connect: jest.fn() } }));

import prisma from "../../src/lib/prisma.js";
import { reserveInventory } from "../../src/lib/rate-client.js";

const mockPrisma = prisma as any;
const mockReserve = reserveInventory as jest.Mock;

const BOOKING_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const TX_ID = "f1b2c3d4-e5f6-4890-abcd-ef1234567890";
const HOTEL_ID = "c1b2c3d4-e5f6-4890-abcd-ef1234567890";
const ROOM_TYPE_ID = "d1b2c3d4-e5f6-4890-abcd-ef1234567890";

function booking(overrides: Record<string, unknown> = {}) {
  return {
    booking_id: BOOKING_ID,
    guest_id: "b1b2c3d4-e5f6-4890-abcd-ef1234567890",
    guest_name: "Ana",
    hotel_id: HOTEL_ID,
    room_type_id: ROOM_TYPE_ID,
    check_in: new Date("2026-11-10"),
    check_out: new Date("2026-11-13"),
    channel: "direct",
    channel_external_id: null,
    status: "pending",
    payment_status: "PENDING",
    payment_method_preference: "ONLINE",
    total_amount: 1260,
    version: 0,
    manage_token_hash: null,
    manage_token_expires_at: null,
    ...overrides,
  };
}

const event = { booking_id: BOOKING_ID, transaction_id: TX_ID, amount: 1260, currency: "COP" };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  mockPrisma.inventoryReservationAttempt.upsert.mockImplementation(async ({ create }: any) => create);
});

describe("create con payment_method_preference", () => {
  const input = {
    hotel_id: HOTEL_ID,
    room_type_id: ROOM_TYPE_ID,
    check_in: "2026-11-10",
    check_out: "2026-11-13",
    channel: "direct" as const,
    total_amount: 1260,
    guest: { name: "Ana", email: "ana@example.com", phone: "+573001112233" },
  };

  it("RECEPTION nace confirmed con pago pendiente (Flujo B)", async () => {
    mockPrisma.booking.create.mockResolvedValue(booking({ payment_method_preference: "RECEPTION" }));
    mockPrisma.booking.findUnique
      .mockResolvedValueOnce(booking({ payment_method_preference: "RECEPTION" })) // confirm: acceso
      .mockResolvedValueOnce(booking({ payment_method_preference: "RECEPTION", status: "confirmed", version: 1 }));
    mockReserve.mockResolvedValue({});
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

    const result = await bookingService.create({ ...input, payment_method_preference: "RECEPTION" });

    expect(mockPrisma.booking.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ payment_method_preference: "RECEPTION", payment_status: "PENDING" }),
    });
    expect(mockReserve).toHaveBeenCalled();
    expect(result.status).toBe("confirmed");
    expect(result.payment_status).toBe("PENDING");
    expect(result.manage_token).toHaveLength(64);
  });

  it("RECEPTION sin stock cancela la reserva y responde 409", async () => {
    mockPrisma.booking.create.mockResolvedValue(booking({ payment_method_preference: "RECEPTION" }));
    mockPrisma.booking.findUnique.mockResolvedValue(booking({ payment_method_preference: "RECEPTION" }));
    mockReserve.mockRejectedValue(new AppError(409, "Insufficient availability", "Conflict"));
    mockPrisma.booking.update.mockResolvedValue(booking({ status: "cancelled" }));

    await expect(
      bookingService.create({ ...input, payment_method_preference: "RECEPTION" })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({
      where: { booking_id: BOOKING_ID },
      data: { status: "cancelled" },
    });
  });

  it("ONLINE nace pending y no toca inventario", async () => {
    mockPrisma.booking.create.mockResolvedValue(booking());
    const result = await bookingService.create({ ...input, payment_method_preference: "ONLINE" });
    expect(result.status).toBe("pending");
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it("sin preferencia: teléfono queda RECEPTION pero no se auto-confirma", async () => {
    mockPrisma.booking.create.mockResolvedValue(booking({ channel: "phone" }));
    await bookingService.create({ ...input, channel: "phone" as any });
    expect(mockPrisma.booking.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ payment_method_preference: "RECEPTION" }),
    });
    expect(mockReserve).not.toHaveBeenCalled();
  });
});

describe("applyPaymentCompleted", () => {
  it("confirma una reserva pending (Flujo A) y la marca PAID", async () => {
    mockPrisma.booking.findUnique
      .mockResolvedValueOnce(booking()) // lectura inicial
      .mockResolvedValueOnce(booking()) // confirm: acceso
      .mockResolvedValueOnce(booking({ status: "confirmed", version: 1 })) // confirm: resultado
      .mockResolvedValueOnce(booking({ status: "confirmed", version: 1 })); // relectura
    mockReserve.mockResolvedValue({});
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

    await expect(bookingService.applyPaymentCompleted(event)).resolves.toBe("paid");

    expect(mockPrisma.booking.updateMany).toHaveBeenLastCalledWith({
      where: { booking_id: BOOKING_ID, version: 1, payment_status: "PENDING" },
      data: expect.objectContaining({ payment_status: "PAID", payment_transaction_id: TX_ID }),
    });
    expect(mockPrisma.eventOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event_type: "booking.paid" }),
    });
  });

  it("en reserva ya confirmada (Flujo B) solo marca PAID", async () => {
    const confirmed = booking({ status: "confirmed", payment_method_preference: "RECEPTION", version: 3 });
    mockPrisma.booking.findUnique.mockResolvedValue(confirmed);
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

    await expect(bookingService.applyPaymentCompleted(event)).resolves.toBe("paid");
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it("es idempotente si la reserva ya está PAID", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(booking({ status: "confirmed", payment_status: "PAID" }));
    await expect(bookingService.applyPaymentCompleted(event)).resolves.toBe("already_paid");
    expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it("registra el pago aunque no haya stock para confirmar (sin cancelar)", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(booking());
    mockReserve.mockRejectedValue(new AppError(409, "Insufficient availability", "Conflict"));
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(bookingService.applyPaymentCompleted(event)).resolves.toBe("paid");
    expect(mockPrisma.booking.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "cancelled" } })
    );
  });

  it("ante conflicto de versión persistente devuelve 409", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(booking({ status: "confirmed" }));
    mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
    await expect(bookingService.applyPaymentCompleted(event)).rejects.toMatchObject({ statusCode: 409 });
    expect(mockPrisma.booking.updateMany).toHaveBeenCalledTimes(3);
  });
});

describe("consumidor payment.completed", () => {
  const channel = { ack: jest.fn(), nack: jest.fn() };
  const msg = (body: unknown) => ({ content: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) }) as any;

  beforeEach(() => {
    channel.ack.mockReset();
    channel.nack.mockReset();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("hace ack tras aplicar el pago", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(booking({ status: "confirmed", payment_status: "PAID" }));
    const m = msg(event);
    await handlePaymentMessage(channel, m, 0);
    expect(channel.ack).toHaveBeenCalledWith(m);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("descarta (ack) payloads inválidos sin tocar la base", async () => {
    await handlePaymentMessage(channel, msg({ booking_id: "no-uuid" }), 0);
    await handlePaymentMessage(channel, msg("{no json"), 0);
    expect(channel.ack).toHaveBeenCalledTimes(2);
    expect(mockPrisma.booking.findUnique).not.toHaveBeenCalled();
  });

  it("re-encola ante un error transitorio", async () => {
    jest.useFakeTimers();
    mockPrisma.booking.findUnique.mockRejectedValue(new Error("db down"));
    const m = msg(event);
    await handlePaymentMessage(channel, m, 10);
    jest.advanceTimersByTime(10);
    expect(channel.nack).toHaveBeenCalledWith(m, false, true);
    expect(channel.ack).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
