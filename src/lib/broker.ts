import amqplib, { ConfirmChannel, ChannelModel } from "amqplib";

const EXCHANGE = "hotelsync.events";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

let connection: ChannelModel | null = null;
let confirmChannel: ConfirmChannel | null = null;
let connecting: Promise<ConfirmChannel> | null = null;

/**
 * Conexión única y perezosa a RabbitMQ con reconexión exponencial.
 * Devuelve un canal con *publisher confirms* para garantizar entrega
 * (el broker no confirma hasta haber persistido el mensaje).
 */
export async function connect(): Promise<ConfirmChannel> {
  if (confirmChannel) return confirmChannel    ;

  connecting ??= (async () => {
    let attempt = 0;
    for (;;) {
      try {
        const conn = await amqplib.connect(RABBITMQ_URL);
        connection = conn;
        conn.on("error", () => {
          /* listener obligatorio para evitar crash; la 'close' dispara la reconexión */
        });
        conn.on("close", async () => {
          confirmChannel = null;
          connecting = null;
          await sleep(RETRY_BASE_MS);
          void connect();
        });

        const channel = await conn.createConfirmChannel();
        await channel.assertExchange(EXCHANGE, "topic", { durable: true });
        confirmChannel = channel;
        return channel;
      } catch (err) {
        attempt += 1;
        const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
        console.warn(
          `[broker] no se pudo conectar a RabbitMQ (intento ${attempt}), reintento en ${delay}ms`
        );
        await sleep(delay);
      }
    }
  })();

  return connecting;
}

/** Publica un mensaje persistente en el exchange topic y espera el confirm. */
export async function publish(
  routingKey: string,
  payload: unknown,
  options: { persistent?: boolean } = {}
): Promise<void> {
  const channel = await connect();
  await new Promise<void>((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, ...options },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

export type Dispatcher = {
  /** Lee eventos pendientes del outbox, los publica con confirm y marca como enviados. */
  flush: (max?: number) => Promise<number>;
  /** Publica un único evento y devuelve true si el broker confirmó. */
  publishOne: (routingKey: string, payload: unknown) => Promise<boolean>;
};

export function createDispatcher(
  getPending: (
    max?: number
  ) => Promise<Array<{ event_id: string; event_type: string; payload: unknown }>>,
  markSent: (eventId: string) => Promise<void>,
  logger: Pick<Console, "error" | "warn" | "debug"> = console
): Dispatcher {
  return {
    async publishOne(routingKey, payload) {
      try {
        await publish(routingKey, payload);
        return true;
      } catch (err) {
        logger.error(`[dispatcher] error publicando ${routingKey}`, err);
        return false;
      }
    },

    async flush(max = 100) {
      const rows = await getPending(max);
      let delivered = 0;

      for (const row of rows) {
        const ok = await this.publishOne(row.event_type, row.payload);
        if (!ok) break; // broker caído: detener y reintentar en el próximo tick
        await markSent(row.event_id);
        delivered += 1;
      }

      if (rows.length > 0) {
        logger.debug(`[dispatcher] outbox flush: ${delivered}/${rows.length} entregados`);
      }
      return delivered;
    },
  };
}

/** Bucle de fondo que drena el outbox cada `intervalMs`. Llamar una sola vez en index.ts. */
export function startDispatcher(
  flush: () => Promise<unknown>,
  intervalMs = 10000
): NodeJS.Timeout {
  const timer = setInterval(() => {
    flush().catch((err) => console.error("[dispatcher] flush falló", err));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const broker = { connect, publish, createDispatcher, startDispatcher };
