-- PRD payment-service (2026-10-14): estado de cobro independiente del estado
-- de la reserva. No se agrega ningún valor nuevo a "status".
--
-- Backfill: las reservas existentes se crearon con "pago en recepción"
-- (el front decía "El pago se realiza al hacer check-in"), así que nacen
-- RECEPTION/PENDING. Las reservas nuevas toman el default ONLINE.
ALTER TABLE "bookings"
    ADD COLUMN "payment_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    ADD COLUMN "payment_method_preference" VARCHAR(20) NOT NULL DEFAULT 'RECEPTION',
    ADD COLUMN "payment_transaction_id" UUID,
    ADD COLUMN "paid_at" TIMESTAMPTZ(6);

ALTER TABLE "bookings" ALTER COLUMN "payment_method_preference" SET DEFAULT 'ONLINE';

ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_payment_status_check"
    CHECK ("payment_status" IN ('PENDING', 'PAID'));
ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_payment_method_preference_check"
    CHECK ("payment_method_preference" IN ('ONLINE', 'RECEPTION'));

CREATE INDEX "bookings_hotel_id_payment_status_idx"
    ON "bookings"("hotel_id", "payment_status");
