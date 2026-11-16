import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { broker } from "./broker.js";
import { bookingService } from "../services/booking.service.js";
import { paymentCompletedEventSchema } from "../validators/booking.js";
import { handleDelivery } from "./consumer-delivery.js";

const EXCHANGE = "hotelsync.events";
const QUEUE = "booking.payments";
const ROUTING_KEY = "payment.completed";
const RESUBSCRIBE_DELAY_MS = 2_000;

/**
 * Consumidor de `payment.completed` (payment-service → booking-service).
 *
 * - Cola durable propia, prefetch 1 y ack manual: un mensaje solo se
 *   descarta cuando la reserva quedó marcada (o el evento es inválido).
 * - Idempotente: `applyPaymentCompleted` ignora reservas ya `PAID`, así que
 *   una re-entrega del broker no produce efectos dobles.
 * - Errores transitorios: retry con backoff acotado y DLQ (`consumer-delivery.ts`).
 */
export async function handlePaymentMessage(
  channel: Pick<ConfirmChannel, "ack" | "nack" | "sendToQueue">,
  msg: ConsumeMessage
): Promise<void> {
  await handleDelivery(
    channel,
    QUEUE,
    `${QUEUE}.dlq`,
    async (_routingKey, raw) => {
      const parsed = paymentCompletedEventSchema.safeParse(raw);
      if (!parsed.success) {
        console.error("[payments-consumer] payload inválido, se descarta", parsed.error.issues);
        return;
      }

      const outcome = await bookingService.applyPaymentCompleted(parsed.data);
      if (outcome === "not_found") {
        console.warn(`[payments-consumer] reserva ${parsed.data.booking_id} no existe, se descarta`);
      }
    },
    msg
  );
}

export async function startPaymentConsumer(): Promise<void> {
  const channel = await broker.connect();
  const deadLetterQueue = `${QUEUE}.dlq`;
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.assertQueue(deadLetterQueue, { durable: true });
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
