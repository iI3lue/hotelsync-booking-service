import type { ConfirmChannel, ConsumeMessage } from "amqplib";

export const RETRY_COUNT_HEADER = "x-retry-count";
export const LAST_ERROR_HEADER = "x-last-error";
export const MAX_DELIVERY_ATTEMPTS = 3;
/**
 * Backoff pensado para el free tier de Render: una dependencia dormida puede
 * tardar ~60 s en despertar, por eso la última espera es de un minuto.
 */
export const RETRY_DELAYS_MS = [2000, 15000, 60000];

export type DeliveryHandler = (routingKey: string, payload: unknown) => Promise<void>;
export type DeliveryChannel = Pick<ConfirmChannel, "ack" | "nack" | "sendToQueue">;
export type DeliveryLogger = Pick<Console, "error" | "warn">;

/** Intentos previos registrados en el mensaje (0 si no trae header válido). */
export function retryCount(message: ConsumeMessage): number {
  const raw = message.properties?.headers?.[RETRY_COUNT_HEADER];
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? 0), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

/** Espera antes del próximo intento; el último valor se repite si hace falta. */
export function retryDelay(attempts: number): number {
  const index = Math.min(Math.max(attempts, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index];
}

function republish(
  channel: DeliveryChannel,
  queue: string,
  message: ConsumeMessage,
  attempts: number,
  reason: string,
  done: () => void,
  delayMs: number,
  log: DeliveryLogger
): void {
  const send = (): void => {
    try {
      channel.sendToQueue(
        queue,
        message.content,
        {
          persistent: true,
          contentType: message.properties?.contentType ?? "application/json",
          messageId: message.properties?.messageId,
          headers: {
            ...(message.properties?.headers ?? {}),
            [RETRY_COUNT_HEADER]: attempts,
            [LAST_ERROR_HEADER]: reason.slice(0, 500),
          },
        },
        (error) => {
          if (error) {
            log.error(`[broker] no se pudo republicar en ${queue}; se devuelve a la cola`, error);
            channel.nack(message, false, true);
            return;
          }
          done();
        }
      );
    } catch (error) {
      log.error(`[broker] no se pudo republicar en ${queue}; se devuelve a la cola`, error);
      channel.nack(message, false, true);
    }
  };

  if (delayMs > 0) setTimeout(send, delayMs);
  else send();
}

/**
 * Procesa una entrega con ack manual y reintentos acotados.
 *
 * - Éxito: `ack`.
 * - Payload no parseable: `ack` (nunca se podrá procesar; evita un bucle).
 * - Error del handler: republica en la misma cola con `x-retry-count` y
 *   backoff; tras `MAX_DELIVERY_ATTEMPTS` la manda a `${queue}.dlq`.
 *
 * Nunca hace requeue en caliente: un error persistente no debe generar
 * redeliveries infinitas (cada una consume cuota del broker).
 */
export async function handleDelivery(
  channel: DeliveryChannel,
  queue: string,
  deadLetterQueue: string,
  handler: DeliveryHandler,
  message: ConsumeMessage,
  log: DeliveryLogger = console
): Promise<void> {
  const routingKey = message.fields.routingKey;

  let payload: unknown;
  try {
    payload = JSON.parse(message.content.toString());
  } catch (error) {
    log.error(`[broker] ${routingKey} no es JSON válido, se descarta`, describeError(error));
    channel.ack(message);
    return;
  }

  try {
    await handler(routingKey, payload);
    channel.ack(message);
  } catch (error) {
    const attempts = retryCount(message);
    const reason = describeError(error);

    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      log.error(
        `[broker] ${routingKey} agotó ${attempts} reintentos; se envía a ${deadLetterQueue}: ${reason}`
      );
      republish(channel, deadLetterQueue, message, attempts, reason, () => channel.ack(message), 0, log);
      return;
    }

    const delay = retryDelay(attempts);
    log.warn(
      `[broker] error procesando ${routingKey} (reintento ${attempts + 1}/${MAX_DELIVERY_ATTEMPTS} en ${delay}ms): ${reason}`
    );
    republish(
      channel,
      queue,
      message,
      attempts + 1,
      reason,
      () => channel.ack(message),
      delay,
      log
    );
  }
}
