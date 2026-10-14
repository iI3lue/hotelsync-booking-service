import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { broker } from "./broker.js";
import { bookingService } from "../services/booking.service.js";
import { paymentCompletedEventSchema } from "../validators/booking.js";
import { AppError } from "../middleware/error-handler.js";

const EXCHANGE = "hotelsync.events";
const QUEUE = "booking.payments";
const ROUTING_KEY = "payment.completed";
const RETRY_DELAY_MS = 5_000;
const RESUBSCRIBE_DELAY_MS = 2_000;

/**
 * Consumidor de `payment.completed` (payment-service → booking-service).
 *
 * - Cola durable propia, prefetch 1 y ack manual: un mensaje solo se
 *   descarta cuando la reserva quedó marcada (o el evento es inválido).
 * - Idempotente: `applyPaymentCompleted` ignora reservas ya `PAID`, así que
 *   una re-entrega del broker no produce efectos dobles.
 * - Errores transitorios (DB, conflicto de versión): se re-encola tras una
 *   pausa corta para no entrar en un bucle caliente.
 */
export async function handlePaymentMessage(
  channel: Pick<ConfirmChannel, "ack" | "nack">,
  msg: ConsumeMessage,
  delayMs = RETRY_DELAY_MS
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(msg.content.toString("utf8"));
  } catch {
    console.error("[payments-consumer] mensaje no es JSON, se descarta");
    channel.ack(msg);
    return;
  }

  const parsed = paymentCompletedEventSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[payments-consumer] payload inválido, se descarta", parsed.error.issues);
    channel.ack(msg);
    return;
  }

  try {
    const outcome = await bookingService.applyPaymentCompleted(parsed.data);
    if (outcome === "not_found") {
      console.warn(`[payments-consumer] reserva ${parsed.data.booking_id} no existe, se descarta`);
    }
    channel.ack(msg);
  } catch (error) {
    const reason = error instanceof AppError ? error.message : String(error);
    console.error(
      `[payments-consumer] error aplicando pago booking=${parsed.data.booking_id}: ${reason}; reintento en ${delayMs}ms`
    );
    setTimeout(() => channel.nack(msg, false, true), delayMs).unref?.();
  }
}

export async function startPaymentConsumer(): Promise<void> {
  const channel = await broker.connect();
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
  await channel.prefetch(1);
  await channel.consume(
    QUEUE,
    (msg) => {
      if (!msg) return; // cancelado por el broker
      void handlePaymentMessage(channel, msg);
    },
    { noAck: false }
  );

  // El broker reconecta el canal solo; la suscripción hay que rehacerla.
  channel.once("close", () => {
    setTimeout(() => {
      startPaymentConsumer().catch((err) =>
        console.error("[payments-consumer] no se pudo re-suscribir", err)
      );
    }, RESUBSCRIBE_DELAY_MS).unref?.();
  });
  console.log(`[payments-consumer] escuchando ${ROUTING_KEY} en ${QUEUE}`);
}
