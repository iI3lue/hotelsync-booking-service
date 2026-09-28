import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding booking database...");

  const checkIn = new Date();
  checkIn.setDate(checkIn.getDate() + 7);
  const checkOut = new Date();
  checkOut.setDate(checkOut.getDate() + 10);

  await prisma.booking.create({
    data: {
      guest_id: "11111111-1111-4111-8111-111111111111",
      hotel_id: "22222222-2222-4222-8222-222222222222",
      room_type_id: "33333333-3333-4333-8333-333333333333",
      check_in: checkIn,
      check_out: checkOut,
      channel: "direct",
      total_amount: 25500.0,
    },
  });

  console.log("Seed data created successfully.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
