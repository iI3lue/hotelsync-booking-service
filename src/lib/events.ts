/**
 * Event stub — Fase 1 MVP.
 *
 * Los eventos se publican como log estructurado con trazabilidad por
 * `booking_id`. El contrato canónico es propiedad de Booking: el Channel
 * Manager entrega reservas por API y nunca publica eventos de Booking.
 * `booking.created` significa pending; `booking.confirmed` se publica solo
 * tras reservar inventario y confirmar la transición local.
 */
export type BookingEventType =
  | "booking.created"
  | "booking.confirmed"
  | "booking.cancelled";

export function publishEvent(
  type: BookingEventType,
  payload: { booking_id: string; [key: string]: unknown }
): void {
  console.log(`[events] ${type} booking_id=${payload.booking_id}`, payload);
}
