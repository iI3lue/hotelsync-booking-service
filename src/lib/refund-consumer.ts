import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { broker } from "./broker.js";
import { bookingService } from "../services/booking.service.js";
import { paymentRefundedEventSchema } from "../validators/booking.js";
import { handleDelivery } from "./consumer-delivery.js";

const EXCHANGE = "hotelsync.events";
const QUEUE = "booking.refunds";
const ROUTING_KEY = "payment.refunded";
const RESUBSCRIBE_DELAY_MS = 2_000;

/**
 * Consumidor de `payment.refunded` (payment-service -> booking-service).
 * Refleja el reembolso simulado en la reserva cancelada. Idempotente: una
 * re-entrega no cambia nada si ya está REFUNDED. Los errores transitorios se
 * reintentan con backoff acotado y terminan en `${QUEUE}.dlq`.
 */
export async function handleRefundMessage(
  channel: Pick<ConfirmChannel, "ack" | "nack" | "sendToQueue">,
  msg: ConsumeMessage
): Promise<void> {
  await handleDelivery(
    channel,
    QUEUE,
    `${QUEUE}.dlq`,
    async (_routingKey, raw) => {
      const parsed = paymentRefundedEventSchema.safeParse(raw);
      if (!parsed.success) {
        console.error("[refunds-consumer] payload inválido, se descarta", parsed.error.issues);
        return;
      }

      const outcome = await bookingService.applyPaymentRefunded(parsed.data);
      if (outcome === "not_found") {
        console.warn(`[refunds-consumer] reserva ${parsed.data.booking_id} no existe, se descarta`);
      }
    },
    msg
  );
}

export async function startRefundConsumer(): Promise<void> {
  const channel = await broker.connect();
  const deadLetterQueue = `${QUEUE}.dlq`;
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.assertQueue(deadLetterQueue, { durable: true });
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
