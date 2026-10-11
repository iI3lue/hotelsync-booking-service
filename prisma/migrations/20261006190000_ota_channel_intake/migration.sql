-- Contrato interno de ingesta OTA (§5.4 PRD Channel Manager):
-- canal validado contra catálogo + id externo idempotente.
ALTER TABLE "bookings" ADD COLUMN "channel_external_id" VARCHAR(100);

ALTER TABLE "bookings" ALTER COLUMN "channel" TYPE VARCHAR(40);

-- NULLs no colisionan en Postgres: direct/phone sin external_id son libres.
CREATE UNIQUE INDEX "bookings_channel_channel_external_id_key" ON "bookings"("channel", "channel_external_id");
