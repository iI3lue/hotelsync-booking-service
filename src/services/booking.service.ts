import {
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

function hashManageToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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

    const manageToken = randomBytes(32).toString("hex");

    // Outbox transaccional: reserva + evento se confirman juntos.
    // Si el proceso muere aquí, no hay fila en outbox (rollback) y el
    // dispatcher nunca publica un evento huérfano. El dispatcher publica
    // a RabbitMQ con confirm y marca `sent` solo tras el confirm.
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
          total_amount: data.total_amount,
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
      });

      return created;
    });

    return { ...stripManageHash(booking), manage_token: manageToken };
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

    // Claves distintas para reservar y para compensar: si la reserva
    // aplicó y la compensación usa otra clave, no se deduplica entre sí.
    await reserveInventory({ ...range, idempotency_key: `booking:${id}:confirm` });

    const updated = await prisma.booking.updateMany({
      where: {
        booking_id: id,
        status: "pending",
        version: existing.version,
      },
      data: {
        status: "confirmed",
        version: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      await releaseInventory({
        ...range,
        idempotency_key: `booking:${id}:confirm-compensate`,
      }).catch(() => undefined);
      throw new AppError(
        409,
        "Booking was modified concurrently, please retry",
        "Conflict"
      );
    }

    return stripManageHash(await this.findById(id));
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
      });

      return updated;
    });

    return stripManageHash(cancelled);
  }
}

export const bookingService = new BookingService();
