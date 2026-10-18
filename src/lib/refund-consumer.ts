import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { broker } from "./broker.js";
import { bookingService } from "../services/booking.service.js";
import { paymentRefundedEventSchema } from "../validators/booking.js";
import { AppError } from "../middleware/error-handler.js";

const EXCHANGE = "hotelsync.events";
const QUEUE = "booking.refunds";
const ROUTING_KEY = "payment.refunded";
const RETRY_DELAY_MS = 5_000;
const RESUBSCRIBE_DELAY_MS = 2_000;

/**
 * Consumidor de `payment.refunded` (payment-service -> booking-service).
 * Refleja el reembolso simulado en la reserva cancelada. Idempotente: una
 * re-entrega no cambia nada si ya está REFUNDED.
 */
export async function handleRefundMessage(
  channel: Pick<ConfirmChannel, "ack" | "nack">,
  msg: ConsumeMessage,
  delayMs = RETRY_DELAY_MS
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(msg.content.toString("utf8"));
  } catch {
    console.error("[refunds-consumer] mensaje no es JSON, se descarta");
    channel.ack(msg);
    return;
  }

  const parsed = paymentRefundedEventSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[refunds-consumer] payload inválido, se descarta", parsed.error.issues);
    channel.ack(msg);
    return;
  }

  try {
    const outcome = await bookingService.applyPaymentRefunded(parsed.data);
    if (outcome === "not_found") {
      console.warn(`[refunds-consumer] reserva ${parsed.data.booking_id} no existe, se descarta`);
    }
    channel.ack(msg);
  } catch (error) {
    const reason = error instanceof AppError ? error.message : String(error);
    console.error(
      `[refunds-consumer] error aplicando reembolso booking=${parsed.data.booking_id}: ${reason}; reintento en ${delayMs}ms`
    );
    setTimeout(() => channel.nack(msg, false, true), delayMs).unref?.();
  }
}

export async function startRefundConsumer(): Promise<void> {
  const channel = await broker.connect();
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
  await channel.prefetch(1);
  await channel.consume(
    QUEUE,
    (msg) => {
      if (!msg) return;
      void handleRefundMessage(channel, msg);
    },
    { noAck: false }
  );

  channel.once("close", () => {
    setTimeout(() => {
      startRefundConsumer().catch((err) =>
        console.error("[refunds-consumer] no se pudo re-suscribir", err)
      );
    }, RESUBSCRIBE_DELAY_MS).unref?.();
  });
  console.log(`[refunds-consumer] escuchando ${ROUTING_KEY} en ${QUEUE}`);
}
