import { z } from "zod";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format");

export const bookingStatusSchema = z.enum([
  "pending",
  "confirmed",
  "cancelled",
]);

export const bookingChannelSchema = z.enum(["direct", "ota", "phone"]);

const guestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().toLowerCase().email().max(255),
  phone: z.string().trim().min(1).max(50),
});

/**
 * Reserva anonima: el navegador envia los datos de contacto del huesped y
 * el backend genera `guest_id` + `manage_token` del lado servidor. Nunca se
 * acepta un `guest_id` elegido por el cliente.
 */
export const createBookingSchema = z
  .object({
    hotel_id: z.string().uuid(),
    room_type_id: z.string().uuid(),
    check_in: dateSchema,
    check_out: dateSchema,
    channel: bookingChannelSchema.default("direct"),
    total_amount: z.number().nonnegative(),
    guest: guestSchema,
  })
  .refine((data) => data.check_out > data.check_in, {
    message: "check_out must be after check_in",
    path: ["check_out"],
  });

export const bookingIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const listBookingsQuerySchema = z.object({
  hotel_id: z.string().uuid().optional(),
  status: bookingStatusSchema.optional(),
  date: dateSchema.optional(),
});

/**
 * Token de gestion anonima. Viaja preferentemente en el header
 * `x-manage-token` (en query queda en logs e historial); se acepta
 * `GET /:id?token=` y `POST /:id/cancel?token=` por compatibilidad.
 */
export const manageTokenQuerySchema = z.object({
  token: z.string().min(1).max(256).optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export type ManageTokenQuery = z.infer<typeof manageTokenQuerySchema>;
