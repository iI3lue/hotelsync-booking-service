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

export const createBookingSchema = z
  .object({
    guest_id: z.string().uuid(),
    hotel_id: z.string().uuid(),
    room_type_id: z.string().uuid(),
    check_in: dateSchema,
    check_out: dateSchema,
    channel: bookingChannelSchema.default("direct"),
    total_amount: z.number().nonnegative(),
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

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
