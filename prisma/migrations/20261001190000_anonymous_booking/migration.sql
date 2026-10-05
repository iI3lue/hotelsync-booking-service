-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "guest_name" VARCHAR(255),
ADD COLUMN "guest_email" VARCHAR(255),
ADD COLUMN "guest_phone" VARCHAR(50),
ADD COLUMN "booked_by_user_id" UUID,
ADD COLUMN "manage_token_hash" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_manage_token_hash_key" ON "bookings"("manage_token_hash");
