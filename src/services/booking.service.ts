import {
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import prisma from "../lib/prisma.js";
import { AppError } from "../middleware/error-handler.js";
import { enqueueOutboxEvent } from "../lib/outbox.js";
import { reserveInventory, releaseInventory } from "../lib/rate-client.js";
import type { AuthClaims } from "../lib/auth.js";
import {
  CreateBookingInput,
  ListBookingsQuery,
  PaymentCompletedEvent,
  PaymentMethodPreference,
} from "../validators/booking.js";

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Quien pide ver/gestionar una reserva: staff logueado y/o manage token. */
export interface BookingAccess {
  actor?: AuthClaims;
  token?: string;
  serviceAuthorized?: boolean;
}

const STAFF_ROLES = ["SUPER_ADMIN", "MANAGER", "RECEPTIONIST"];

/** Vigencia del codigo de gestion anonima (reutilizable dentro del plazo). */
export const MANAGE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CONFIRMATION_RECONCILE_BATCH = 50;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

function hashManageToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newManageToken(data: CreateBookingInput): string {
  if (data.channel.startsWith("ota:") && data.channel_external_id) {
    const secret = process.env.CHANNEL_MANAGER_MANAGE_TOKEN_SECRET;
    if (secret && secret.length >= 32) {
      // El mismo request OTA siempre obtiene el mismo token, incluso si el
      // CM reintenta tras perder la respuesta. La key es dedicada y estable;
      // no reutilizar la service key que puede rotarse independientemente.
      return createHmac("sha256", secret)
        .update(`${data.channel}\0${data.channel_external_id}`)
        .digest("hex");
    }
    if (process.env.NODE_ENV === "test") {
      return createHmac("sha256", "test-channel-manage-token-secret-32b!")
        .update(`${data.channel}\0${data.channel_external_id}`)
        .digest("hex");
    }
    throw new Error(
      "CHANNEL_MANAGER_MANAGE_TOKEN_SECRET must be set (min 32 chars)"
    );
  }
  return randomBytes(32).toString("hex");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 5), RETRY_MAX_MS);
}

type ConfirmationBooking = {
  booking_id: string;
  version: number;
  guest_id: string;
  guest_name: string | null;
  hotel_id: string;
  room_type_id: string;
  check_in: Date;
  check_out: Date;
  channel: string;
  channel_external_id: string | null;
};

type ManagedBooking = {
  manage_token_hash: string | null;
  manage_token_expires_at: Date | null;
};

function manageTokenMatches(booking: ManagedBooking, token: string): boolean {
  if (!booking.manage_token_hash) return false;
  if (
    booking.manage_token_expires_at &&
    booking.manage_token_expires_at.getTime() < Date.now()
  ) {
    return false;
  }
  const expected = Buffer.from(booking.manage_token_hash, "hex");
  const actual = Buffer.from(hashManageToken(token), "hex");
  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}

/**
 * Preferencia de pago efectiva. Sin valor explícito se conserva el
 * comportamiento histórico: la web directa paga en línea; teléfono y OTA
 * se cobran en el hotel.
 */
function resolvePaymentPreference(data: CreateBookingInput): PaymentMethodPreference {
  if (data.payment_method_preference) return data.payment_method_preference;
  return data.channel === "direct" ? "ONLINE" : "RECEPTION";
}

const PAYMENT_APPLY_MAX_ATTEMPTS = 3;

export type PaymentApplyOutcome =
  | "paid"
  | "already_paid"
  | "not_found";

function stripManageHash<T extends { manage_token_hash?: unknown }>(
  booking: T
): Omit<T, "manage_token_hash"> {
  const { manage_token_hash: _removed, ...rest } = booking;
  return rest;
}

export class BookingService {
  /**
   * Alta anonima: el backend genera `guest_id` y un `manage_token` en
   * respuesta (solo se guarda su hash SHA-256, con 30 dias de vigencia y
   * reutilizable en ese plazo). Si quien reserva inicio sesion, queda
   * registrado en `booked_by_user_id`.
   */
  async create(data: CreateBookingInput, actor?: AuthClaims) {
    if (data.check_out <= data.check_in) {
      throw new AppError(
        400,
        "check_out must be after check_in",
        "Bad Request"
      );
    }

    const findChannelReplay = async () => {
      if (data.channel_external_id === undefined) return null;
      return prisma.booking.findUnique({
        where: {
          channel_channel_external_id: {
            channel: data.channel,
            channel_external_id: data.channel_external_id,
          },
        },
      });
    };

    // El token OTA es determinista (HMAC dedicado) para poder repetir la
    // respuesta si el CM perdió el primer response tras un commit exitoso.
    // En web directa se mantiene aleatorio como hasta ahora.
    const manageToken = newManageToken(data);
    const replay = await findChannelReplay();
    if (replay) {
      return {
        ...stripManageHash(replay),
        manage_token: manageToken,
        created: false as const,
      };
    }

    // Outbox transaccional: reserva + evento se confirman juntos.
    // Si el proceso muere aquí, no hay fila en outbox (rollback) y el
    // dispatcher nunca publica un evento huérfano. El dispatcher publica
    // a RabbitMQ con confirm y marca `sent` solo tras el confirm.
    try {
      const booking = await prisma.$transaction(async (tx) => {
        const created = await tx.booking.create({
          data: {
            guest_id: randomUUID(),
            guest_name: data.guest.name,
            guest_email: data.guest.email,
            guest_phone: data.guest.phone,
            booked_by_user_id: actor?.sub ?? null,
            manage_token_hash: hashManageToken(manageToken),
            manage_token_expires_at: new Date(Date.now() + MANAGE_TOKEN_TTL_MS),
            hotel_id: data.hotel_id,
            room_type_id: data.room_type_id,
            check_in: new Date(data.check_in),
            check_out: new Date(data.check_out),
            channel: data.channel,
            channel_external_id: data.channel_external_id ?? null,
            total_amount: data.total_amount,
            payment_method_preference: resolvePaymentPreference(data),
            payment_status: "PENDING",
          },
        });

        await enqueueOutboxEvent(tx, "booking.created", {
          booking_id: created.booking_id,
          guest_id: created.guest_id,
          guest_name: created.guest_name,
          hotel_id: created.hotel_id,
          room_type_id: created.room_type_id,
          check_in: created.check_in.toISOString().slice(0, 10),
          check_out: created.check_out.toISOString().slice(0, 10),
          channel: created.channel,
          channel_external_id: created.channel_external_id ?? null,
          occurred_at: new Date().toISOString(),
        });

        return created;
      });

      // Flujo B (pago en recepción): la reserva nace confirmada con saldo
      // pendiente, compatible con "Front Desk exige confirmed". Solo si el
      // cliente lo pidió explícitamente; OTA/teléfono no cambian.
      if (
        data.payment_method_preference === "RECEPTION" &&
        !data.channel.startsWith("ota:")
      ) {
        const confirmed = await this.confirmForReception(booking.booking_id);
        return {
          ...confirmed,
          manage_token: manageToken,
          created: true as const,
        };
      }

      return {
        ...stripManageHash(booking),
        manage_token: manageToken,
        created: true as const,
      };
    } catch (error) {
      // Dos entregas concurrentes pueden pasar el pre-check a la vez. La
      // UNIQUE de DB elige un ganador; el otro lee y devuelve el mismo recurso.
      if (data.channel_external_id !== undefined && isUniqueConstraintError(error)) {
        const winner = await findChannelReplay();
        if (winner) {
          return {
            ...stripManageHash(winner),
            manage_token: manageToken,
            created: false as const,
          };
        }
      }
      throw error;
    }
  }

  async findById(id: string) {
    const booking = await prisma.booking.findUnique({
      where: { booking_id: id },
    });

    if (!booking) {
      throw new AppError(404, `Booking with id ${id} not found`, "Not Found");
    }

    return booking;
  }

  /**
   * Alcance por hotel: el staff solo opera reservas de su propio hotel.
   * SUPER_ADMIN es global. Sin esto, un rol válido de un hotel podría
   * leer/confirmar/cancelar reservas de otro.
   */
  private requireBookingScope(
    actor: AuthClaims,
    booking: { hotel_id: string }
  ): void {
    if (actor.role === "SUPER_ADMIN") return;
    if (!STAFF_ROLES.includes(actor.role) || actor.hotel_id !== booking.hotel_id) {
      throw new AppError(403, "Not allowed to access this booking", "Forbidden");
    }
  }

  private async ensureReservationAttempt(bookingId: string) {
    const now = new Date();
    return prisma.inventoryReservationAttempt.upsert({
      where: { booking_id: bookingId },
      create: {
        booking_id: bookingId,
        idempotency_key: `booking:${bookingId}:confirm`,
        status: "pending",
        attempts: 1,
        next_attempt_at: now,
      },
      update: {
        status: "pending",
        attempts: { increment: 1 },
        next_attempt_at: now,
        last_error: null,
      },
    });
  }

  private async scheduleReservationRetry(
    bookingId: string,
    attempts: number,
    error: unknown,
    status: "pending" | "compensating" = "pending"
  ): Promise<void> {
    await prisma.inventoryReservationAttempt.update({
      where: { booking_id: bookingId },
      data: {
        status,
        attempts: { increment: 1 },
        next_attempt_at: new Date(Date.now() + retryDelay(attempts)),
        last_error: errorMessage(error),
      },
    });
  }

  /** Local confirmation, outbox event and saga completion commit atomically. */
  private async finalizeConfirmation(booking: ConfirmationBooking): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: {
          booking_id: booking.booking_id,
          status: "pending",
          version: booking.version,
        },
        data: {
          status: "confirmed",
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) return false;

      await enqueueOutboxEvent(tx, "booking.confirmed", {
        booking_id: booking.booking_id,
        guest_id: booking.guest_id,
        guest_name: booking.guest_name,
        hotel_id: booking.hotel_id,
        room_type_id: booking.room_type_id,
        check_in: toIsoDate(booking.check_in),
        check_out: toIsoDate(booking.check_out),
        channel: booking.channel,
        channel_external_id: booking.channel_external_id,
        occurred_at: new Date().toISOString(),
      });
      await tx.inventoryReservationAttempt.update({
        where: { booking_id: booking.booking_id },
        data: { status: "completed", last_error: null },
      });
      return true;
    });
  }

  private async compensateReservation(
    booking: Pick<ConfirmationBooking, "booking_id" | "room_type_id" | "check_in" | "check_out">,
    attemptCount: number
  ): Promise<void> {
    try {
      await releaseInventory({
        room_type_id: booking.room_type_id,
        check_in: toIsoDate(booking.check_in),
        check_out: toIsoDate(booking.check_out),
        idempotency_key: `booking:${booking.booking_id}:confirm-compensate`,
      });
      await prisma.inventoryReservationAttempt.update({
        where: { booking_id: booking.booking_id },
        data: { status: "failed", last_error: null },
      });
    } catch (error) {
      await this.scheduleReservationRetry(
        booking.booking_id,
        attemptCount,
        error,
        "compensating"
      );
      throw error;
    }
  }

  /**
   * Lectura con acceso: staff del mismo hotel o manage token de la reserva.
   * El UUID solo no autoriza. Nunca expone el hash del token.
   */
  async getByIdWithAccess(id: string, access: BookingAccess) {
    if (!access.actor && !access.token && !access.serviceAuthorized) {
      throw new AppError(401, "Missing credentials", "Unauthorized");
    }
    const booking = await this.findById(id);

    if (access.serviceAuthorized) {
      return stripManageHash(booking);
    }
    if (access.actor && STAFF_ROLES.includes(access.actor.role)) {
      this.requireBookingScope(access.actor, booking);
      return stripManageHash(booking);
    }
    if (access.token && manageTokenMatches(booking, access.token)) {
      return stripManageHash(booking);
    }
    throw new AppError(403, "Not allowed to access this booking", "Forbidden");
  }

  /**
   * Listado operativo: requiere staff y fuerza el hotel del actor
   * (salvo SUPER_ADMIN). Nunca expone el hash del manage token.
   */
  async list(query: ListBookingsQuery, actor: AuthClaims) {
    if (!STAFF_ROLES.includes(actor.role)) {
      throw new AppError(403, "Not allowed to list bookings", "Forbidden");
    }
    const hotelId =
      actor.role === "SUPER_ADMIN" ? query.hotel_id : actor.hotel_id;
    const bookings = await prisma.booking.findMany({
      where: {
        ...(hotelId ? { hotel_id: hotelId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.date
          ? {
              check_in: { lte: new Date(query.date) },
              check_out: { gte: new Date(query.date) },
            }
          : {}),
      },
      orderBy: { check_in: "asc" },
    });
    return bookings.map(stripManageHash);
  }

  /**
   * Confirma una reserva pendiente con bloqueo optimista (RN anti-sobreventa).
   *
   * Mini-saga RN-1/RN-2: primero decrementa inventario en Rate & Availability
   * (REST síncrono, lock optimista con CAS sobre `inventory`); solo si el stock
   * se asegura, transiciona a `confirmed`. Si la confirmación local falla por
   * concurrencia, compensa liberando el inventario reservado.
   */
  /**
   * Confirmacion con acceso: staff operativo o manage token del huesped.
   * Cierra el hueco de confirmar con solo el UUID.
   */
  async confirm(id: string, access: BookingAccess) {
    const existing = await this.getByIdWithAccess(id, access);

    if (existing.status !== "pending") {
      throw new AppError(
        409,
        `Cannot confirm booking with status ${existing.status}`,
        "Conflict"
      );
    }

    const range = {
      room_type_id: existing.room_type_id,
      check_in: toIsoDate(existing.check_in),
      check_out: toIsoDate(existing.check_out),
    };
    const attempt = await this.ensureReservationAttempt(id);

    // R&A is remote, so this is a saga, not a cross-database transaction.
    // The durable attempt is written first; retries always use the same key.
    try {
      await reserveInventory({
        ...range,
        idempotency_key: attempt.idempotency_key,
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) {
        await prisma.inventoryReservationAttempt.update({
          where: { booking_id: id },
          data: { status: "failed", last_error: errorMessage(error) },
        });
      } else {
        await this.scheduleReservationRetry(id, attempt.attempts, error);
      }
      throw error;
    }

    let finalized: boolean;
    try {
      finalized = await this.finalizeConfirmation(existing as ConfirmationBooking);
    } catch (error) {
      // Resultado local incierto: no liberar inmediatamente. El intento
      // durable re-ejecutará la reserva idempotente y completará el commit.
      await this.scheduleReservationRetry(id, attempt.attempts, error);
      throw error;
    }

    if (!finalized) {
      const latest = await this.findById(id);
      if (latest.status === "confirmed") {
        // Otra petición ya confirmó y publicó el outbox en su transacción.
        await prisma.inventoryReservationAttempt.update({
          where: { booking_id: id },
          data: { status: "completed", last_error: null },
        });
        return stripManageHash(latest);
      }
      await this.compensateReservation(existing as ConfirmationBooking, attempt.attempts);
      throw new AppError(
        409,
        "Booking was modified concurrently, please retry",
        "Conflict"
      );
    }

    return stripManageHash(await this.findById(id));
  }

  /**
   * Recupera reservas cuyo inventario pudo reservarse antes de que el
   * proceso cayera. Repetir reserve con la misma idempotency_key no descuenta
   * stock dos veces en R&A.
   */
  async reconcilePendingConfirmations(limit = CONFIRMATION_RECONCILE_BATCH) {
    const due = await prisma.inventoryReservationAttempt.findMany({
      where: {
        status: { in: ["pending", "compensating"] },
        next_attempt_at: { lte: new Date() },
      },
      orderBy: { next_attempt_at: "asc" },
      take: limit,
      include: { booking: true },
    });

    for (const attempt of due) {
      const booking = attempt.booking;
      if (attempt.status === "compensating") {
        try {
          await releaseInventory({
            room_type_id: booking.room_type_id,
            check_in: toIsoDate(booking.check_in),
            check_out: toIsoDate(booking.check_out),
            idempotency_key: `booking:${booking.booking_id}:confirm-compensate`,
          });
          await prisma.inventoryReservationAttempt.update({
            where: { booking_id: booking.booking_id },
            data: { status: "failed", last_error: null },
          });
        } catch (error) {
          await this.scheduleReservationRetry(
            booking.booking_id,
            attempt.attempts,
            error,
            "compensating"
          );
        }
        continue;
      }

      if (booking.status === "confirmed") {
        await prisma.inventoryReservationAttempt.update({
          where: { booking_id: booking.booking_id },
          data: { status: "completed", last_error: null },
        });
        continue;
      }
      if (booking.status !== "pending") {
        if (booking.status !== "cancelled") {
          await prisma.inventoryReservationAttempt.update({
            where: { booking_id: booking.booking_id },
            data: { status: "failed", last_error: `Booking is ${booking.status}` },
          });
          continue;
        }
        // A pending attempt is ambiguous after a crash: R&A may or may not
        // have committed the reserve. Reissue the same idempotent reserve
        // first, then release it; releasing directly could inflate stock if
        // the original request never reached R&A.
        try {
          await reserveInventory({
            room_type_id: booking.room_type_id,
            check_in: toIsoDate(booking.check_in),
            check_out: toIsoDate(booking.check_out),
            idempotency_key: attempt.idempotency_key,
          });
        } catch (error) {
          if (error instanceof AppError && error.statusCode === 409) {
            await prisma.inventoryReservationAttempt.update({
              where: { booking_id: booking.booking_id },
              data: { status: "failed", last_error: errorMessage(error) },
            });
          } else {
            await this.scheduleReservationRetry(
              booking.booking_id,
              attempt.attempts,
              error
            );
          }
          continue;
        }
        await this.compensateReservation(booking, attempt.attempts).catch(
          () => undefined
        );
        continue;
      }

      try {
        await reserveInventory({
          room_type_id: booking.room_type_id,
          check_in: toIsoDate(booking.check_in),
          check_out: toIsoDate(booking.check_out),
          idempotency_key: attempt.idempotency_key,
        });
        const finalized = await this.finalizeConfirmation(booking);
        if (!finalized) {
          const latest = await this.findById(booking.booking_id);
          if (latest.status === "confirmed") {
            await prisma.inventoryReservationAttempt.update({
              where: { booking_id: booking.booking_id },
              data: { status: "completed", last_error: null },
            });
          } else {
            await this.compensateReservation(booking, attempt.attempts);
          }
        }
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 409) {
          await prisma.inventoryReservationAttempt.update({
            where: { booking_id: booking.booking_id },
            data: { status: "failed", last_error: errorMessage(error) },
          });
        } else {
          await this.scheduleReservationRetry(
            booking.booking_id,
            attempt.attempts,
            error
          );
        }
      }
    }
    return due.length;
  }

  /**
   * Confirma una reserva recién creada con pago en recepción.
   * - Sin stock (409): la reserva no puede existir confirmada, así que se
   *   cancela (nunca reservó inventario) y se devuelve el 409 al cliente.
   * - R&A caído (502): queda `pending` con el intento durable; el
   *   reconciliador la confirmará cuando R&A vuelva. Se devuelve tal cual.
   */
  private async confirmForReception(bookingId: string) {
    const access: BookingAccess = { serviceAuthorized: true };
    try {
      return await this.confirm(bookingId, access);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) {
        await this.cancel(bookingId, access).catch(() => undefined);
        throw new AppError(
          409,
          "No rooms available for the selected dates",
          "Conflict"
        );
      }
      if (error instanceof AppError && error.statusCode === 502) {
        return stripManageHash(await this.findById(bookingId));
      }
      throw error;
    }
  }

  /**
   * Aplica `payment.completed` (consumidor RabbitMQ). Idempotente: un
   * evento repetido no cambia nada. Con versión optimista; ante conflicto
   * relee y reintenta, y si persiste devuelve 409 para que el consumidor
   * re-encole el mensaje.
   *
   * Si la reserva sigue `pending` (Flujo A), primero la confirma con la
   * misma saga de inventario. Si no hay stock, el pago igual se registra
   * (el dinero ya ingresó) y la reserva queda pendiente para gestión
   * manual: nunca se cancela automáticamente (PRD 2026-10-14).
   */
  async applyPaymentCompleted(event: PaymentCompletedEvent): Promise<PaymentApplyOutcome> {
    for (let attempt = 0; attempt < PAYMENT_APPLY_MAX_ATTEMPTS; attempt += 1) {
      const booking = await prisma.booking.findUnique({
        where: { booking_id: event.booking_id },
      });
      if (!booking) return "not_found";
      if (booking.payment_status === "PAID") return "already_paid";

      if (booking.status === "pending") {
        try {
          await this.confirm(booking.booking_id, { serviceAuthorized: true });
        } catch (error) {
          // 409 sin stock o carrera: se registra el pago igual. 502: el
          // intento durable queda agendado y el reconciliador confirmará.
          console.warn(
            `[payments] booking ${booking.booking_id} paid but not confirmed: ${errorMessage(error)}`
          );
        }
      }

      const fresh = await prisma.booking.findUnique({
        where: { booking_id: event.booking_id },
      });
      if (!fresh) return "not_found";
      if (fresh.payment_status === "PAID") return "already_paid";

      if (Number(fresh.total_amount) !== event.amount) {
        console.warn(
          `[payments] amount mismatch booking=${fresh.booking_id} total=${fresh.total_amount} paid=${event.amount}`
        );
      }

      const marked = await prisma.$transaction(async (tx) => {
        const updated = await tx.booking.updateMany({
          where: {
            booking_id: fresh.booking_id,
            version: fresh.version,
            payment_status: "PENDING",
          },
          data: {
            payment_status: "PAID",
            payment_transaction_id: event.transaction_id,
            paid_at: new Date(),
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) return false;
        await enqueueOutboxEvent(tx, "booking.paid", {
          booking_id: fresh.booking_id,
          hotel_id: fresh.hotel_id,
          transaction_id: event.transaction_id,
          amount: event.amount,
          currency: event.currency,
          status: fresh.status,
          occurred_at: new Date().toISOString(),
        });
        return true;
      });
      if (marked) return "paid";
    }
    throw new AppError(
      409,
      "Booking was modified concurrently, please retry",
      "Conflict"
    );
  }

  /**
   * Reservas propias de una cuenta: creadas con su sesion, o con su email
   * solo si el email esta verificado. Sin esto, registrarse con el correo
   * de otra persona permitiria leer sus reservas.
   */
  async listByUser(userId: string, email: string, emailVerified: boolean) {
    const bookings = await prisma.booking.findMany({
      where: {
        OR: [
          { booked_by_user_id: userId },
          ...(emailVerified ? [{ guest_email: email }] : []),
        ],
      },
      orderBy: { check_in: "asc" },
    });
    return bookings.map(stripManageHash);
  }

  /**
   * Chequeo para la baja de cuentas (user-service, server-to-server):
   * reservas vinculadas a la cuenta en estado pendiente/confirmado con
   * check-out hoy o futuro. Solo `booked_by_user_id` (vínculo exacto de
   * cuenta, sin el fallback por email de `listByUser`).
   */
  async hasActiveByUser(userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const count = await prisma.booking.count({
      where: {
        booked_by_user_id: userId,
        status: { in: ["pending", "confirmed"] },
        check_out: { gte: today },
      },
    });
    return { has_active: count > 0, count };
  }

  /** Cancelacion con acceso: staff o manage token del huesped. */
  async cancel(id: string, access: BookingAccess) {
    const existing = await this.getByIdWithAccess(id, access);

    if (existing.status === "cancelled") {
      throw new AppError(409, "Booking is already cancelled", "Conflict");
    }

    if (existing.status === "confirmed") {
      await releaseInventory({
        room_type_id: existing.room_type_id,
        check_in: toIsoDate(existing.check_in),
        check_out: toIsoDate(existing.check_out),
        idempotency_key: `booking:${id}:cancel`,
      });
    }

    const cancelled = await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { booking_id: id },
        data: { status: "cancelled" },
      });

      await enqueueOutboxEvent(tx, "booking.cancelled", {
        booking_id: updated.booking_id,
        hotel_id: updated.hotel_id,
        room_type_id: updated.room_type_id,
        check_in: toIsoDate(updated.check_in),
        check_out: toIsoDate(updated.check_out),
        channel: updated.channel,
        channel_external_id: updated.channel_external_id,
        occurred_at: new Date().toISOString(),
      });

      return updated;
    });

    return stripManageHash(cancelled);
  }
}

export const bookingService = new BookingService();
