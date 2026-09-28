/**
 * Event stub — Fase 1 MVP.
 *
 * Los eventos se publican como log estructurado con trazabilidad por
 * `booking_id`. En Fase 2 se cablean a RabbitMQ sin cambiar la firma:
 * Front Desk consume `booking.created`, Channel Manager lo publica
 * (reservas OTA) y Billing/Loyalty consumirán `checkout.completed`.
 */
export type BookingEventType =
  | "booking.created"
  | "booking.cancelled";

export function publishEvent(
  type: BookingEventType,
  payload: { booking_id: string; [key: string]: unknown }
): void {
  console.log(`[events] ${type} booking_id=${payload.booking_id}`, payload);
}
