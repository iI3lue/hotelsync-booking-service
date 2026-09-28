import prisma from "../lib/prisma.js";
import { AppError } from "../middleware/error-handler.js";
import { enqueueOutboxEvent } from "../lib/outbox.js";
import { reserveInventory, releaseInventory } from "../lib/rate-client.js";
import {
  CreateBookingInput,
  ListBookingsQuery,
} from "../validators/booking.js";

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class BookingService {
  async create(data: CreateBookingInput) {
    if (data.check_out <= data.check_in) {
      throw new AppError(
        400,
        "check_out must be after check_in",
        "Bad Request"
      );
    }

    // Outbox transaccional: reserva + evento se confirman juntos.
    // Si el proceso muere aquí, no hay fila en outbox (rollback) y el
    // dispatcher nunca publica un evento huérfano. El dispatcher publica
    // a RabbitMQ con confirm y marca `sent` solo tras el confirm.
    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          guest_id: data.guest_id,
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
        hotel_id: created.hotel_id,
        room_type_id: created.room_type_id,
        check_in: created.check_in.toISOString().slice(0, 10),
        check_out: created.check_out.toISOString().slice(0, 10),
        channel: created.channel,
      });

      return created;
    });

    return booking;
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

  async list(query: ListBookingsQuery) {
    return prisma.booking.findMany({
      where: {
        ...(query.hotel_id ? { hotel_id: query.hotel_id } : {}),
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
  }

  /**
   * Confirma una reserva pendiente con bloqueo optimista (RN anti-sobreventa).
   *
   * Mini-saga RN-1/RN-2: primero decrementa inventario en Rate & Availability
   * (REST síncrono, lock optimista con CAS sobre `inventory`); solo si el stock
   * se asegura, transiciona a `confirmed`. Si la confirmación local falla por
   * concurrencia, compensa liberando el inventario reservado.
   */
  async confirm(id: string) {
    const existing = await prisma.booking.findUnique({
      where: { booking_id: id },
    });

    if (!existing) {
      throw new AppError(404, `Booking with id ${id} not found`, "Not Found");
    }

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

    await reserveInventory(range);

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
      await releaseInventory(range).catch(() => undefined);
      throw new AppError(
        409,
        "Booking was modified concurrently, please retry",
        "Conflict"
      );
    }

    return this.findById(id);
  }

  async cancel(id: string) {
    const existing = await prisma.booking.findUnique({
      where: { booking_id: id },
    });

    if (!existing) {
      throw new AppError(404, `Booking with id ${id} not found`, "Not Found");
    }

    if (existing.status === "cancelled") {
      throw new AppError(409, "Booking is already cancelled", "Conflict");
    }

    if (existing.status === "confirmed") {
      await releaseInventory({
        room_type_id: existing.room_type_id,
        check_in: toIsoDate(existing.check_in),
        check_out: toIsoDate(existing.check_out),
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

    return cancelled;
  }
}

export const bookingService = new BookingService();
