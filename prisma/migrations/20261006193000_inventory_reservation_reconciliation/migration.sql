-- Durable saga checkpoint for the R&A reserve -> Booking confirm boundary.
CREATE TABLE "inventory_reservation_attempts" (
    "booking_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(150) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_reservation_attempts_pkey" PRIMARY KEY ("booking_id")
);

CREATE UNIQUE INDEX "inventory_reservation_attempts_idempotency_key_key"
    ON "inventory_reservation_attempts"("idempotency_key");
CREATE INDEX "inventory_reservation_attempts_status_next_attempt_at_idx"
    ON "inventory_reservation_attempts"("status", "next_attempt_at");
ALTER TABLE "inventory_reservation_attempts"
    ADD CONSTRAINT "inventory_reservation_attempts_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("booking_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
