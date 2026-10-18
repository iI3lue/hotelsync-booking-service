-- Allow the REFUNDED state so payment.refunded can be reflected on the booking.
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_payment_status_check";

ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_payment_status_check"
    CHECK ("payment_status" IN ('PENDING', 'PAID', 'REFUNDED'));
