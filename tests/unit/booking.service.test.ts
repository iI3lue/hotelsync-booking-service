import { createHash } from "node:crypto";
import { bookingService } from "../../src/services/booking.service.js";
import { AppError } from "../../src/middleware/error-handler.js";

// Mock Prisma
jest.mock("../../src/lib/prisma.js", () => ({
  __esModule: true,
  default: {
    booking: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    eventOutbox: {
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

// Silence event stub logs
jest.mock("../../src/lib/events.js", () => ({
  publishEvent: jest.fn(),
}));

// Mock Rate & Availability client (RN-1/RN-2 REST)
jest.mock("../../src/lib/rate-client.js", () => ({
  reserveInventory: jest.fn(),
  releaseInventory: jest.fn(),
}));

import prisma from "../../src/lib/prisma.js";
import { reserveInventory, releaseInventory } from "../../src/lib/rate-client.js";

const mockPrisma = prisma as any;
const mockReserve = reserveInventory as jest.Mock;
const mockRelease = releaseInventory as jest.Mock;

// $transaction interactiva: passthrough al mismo mock (tx === prisma mockeado)
mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

const VALID_UUID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const GENERATED_GUEST_ID = "b1b2c3d4-e5f6-4890-abcd-ef1234567890";
const HOTEL_ID = "c1b2c3d4-e5f6-4890-abcd-ef1234567890";
const ROOM_TYPE_ID = "d1b2c3d4-e5f6-4890-abcd-ef1234567890";
const USER_ID = "e1b2c3d4-e5f6-4890-abcd-ef1234567890";

const STAFF = {
  sub: USER_ID,
  email: "staff@example.com",
  email_verified: true,
  role: "RECEPTIONIST",
  hotel_id: HOTEL_ID,
  scope: "hotel" as const,
  iss: "hotelsync",
  aud: "hotelsync-api",
  iat: 0,
  exp: 9999999999,
};

const MANAGE_TOKEN = "guest-manage-token";
const MANAGE_HASH = createHash("sha256").update(MANAGE_TOKEN).digest("hex");

const EXPECTED_RANGE = {
  room_type_id: ROOM_TYPE_ID,
  check_in: "2026-10-01",
  check_out: "2026-10-05",
};

const baseInput = {
  hotel_id: HOTEL_ID,
  room_type_id: ROOM_TYPE_ID,
  check_in: "2026-10-01",
  check_out: "2026-10-05",
  channel: "direct" as const,
  total_amount: 25500,
  guest: { name: "Ana", email: "ana@example.com", phone: "+5491112345678" },
};

describe("BookingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("create", () => {
    it("should create a pending booking with server-generated guest id and manage token", async () => {
      const created = {
        booking_id: VALID_UUID,
        status: "pending",
        hotel_id: HOTEL_ID,
        guest_id: GENERATED_GUEST_ID,
        guest_name: "Ana",
        guest_email: "ana@example.com",
        guest_phone: "+5491112345678",
        booked_by_user_id: null,
        manage_token_hash: MANAGE_HASH,
        room_type_id: ROOM_TYPE_ID,
        channel: "direct",
        total_amount: 25500,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      };
      mockPrisma.booking.create.mockResolvedValue(created);

      const result = await bookingService.create(baseInput);

      expect(result.manage_token).toHaveLength(64);
      expect(result).not.toHaveProperty("manage_token_hash");
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.booking.create).toHaveBeenCalledWith({
        data: {
          guest_id: expect.any(String),
          guest_name: "Ana",
          guest_email: "ana@example.com",
          guest_phone: "+5491112345678",
          booked_by_user_id: null,
          manage_token_hash: expect.any(String),
          manage_token_expires_at: expect.any(Date),
          hotel_id: HOTEL_ID,
          room_type_id: ROOM_TYPE_ID,
          check_in: new Date("2026-10-01"),
          check_out: new Date("2026-10-05"),
          channel: "direct",
          total_amount: 25500,
        },
      });
      expect(mockPrisma.eventOutbox.create).toHaveBeenCalledWith({
        data: {
          event_type: "booking.created",
          payload: {
            booking_id: VALID_UUID,
            guest_id: GENERATED_GUEST_ID,
            guest_name: "Ana",
            hotel_id: HOTEL_ID,
            room_type_id: ROOM_TYPE_ID,
            check_in: "2026-10-01",
            check_out: "2026-10-05",
            channel: "direct",
          },
        },
      });
    });

    it("should record booked_by_user_id when the request is authenticated", async () => {
      mockPrisma.booking.create.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        hotel_id: HOTEL_ID,
        guest_id: GENERATED_GUEST_ID,
        guest_name: "Ana",
        room_type_id: ROOM_TYPE_ID,
        channel: "direct",
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });

      await bookingService.create(baseInput, STAFF);

      expect(mockPrisma.booking.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ booked_by_user_id: USER_ID }),
      });
    });

    it("should reject when check_out is not after check_in", async () => {
      await expect(
        bookingService.create({
          ...baseInput,
          check_in: "2026-10-05",
          check_out: "2026-10-05",
        })
      ).rejects.toThrow(AppError);
      expect(mockPrisma.booking.create).not.toHaveBeenCalled();
    });
  });

  describe("findById", () => {
    it("should return booking when found", async () => {
      const booking = { booking_id: VALID_UUID, status: "pending" };
      mockPrisma.booking.findUnique.mockResolvedValue(booking);

      const result = await bookingService.findById(VALID_UUID);

      expect(result).toEqual(booking);
    });

    it("should throw AppError 404 when not found", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(bookingService.findById(VALID_UUID)).rejects.toThrow(
        AppError
      );
    });
  });

  describe("getByIdWithAccess", () => {
    const stored = {
      booking_id: VALID_UUID,
      status: "pending",
      hotel_id: HOTEL_ID,
      manage_token_hash: MANAGE_HASH,
    };

    it("should allow staff and strip the token hash", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(stored);

      const result = await bookingService.getByIdWithAccess(VALID_UUID, {
        actor: STAFF,
      });

      expect(result.booking_id).toBe(VALID_UUID);
      expect(result).not.toHaveProperty("manage_token_hash");
    });

    it("should reject staff from another hotel", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(stored);

      await expect(
        bookingService.getByIdWithAccess(VALID_UUID, {
          actor: {
            ...STAFF,
            hotel_id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
          },
        })
      ).rejects.toThrow(AppError);
    });

    it("should allow the guest manage token", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(stored);

      const result = await bookingService.getByIdWithAccess(VALID_UUID, {
        token: MANAGE_TOKEN,
      });

      expect(result.booking_id).toBe(VALID_UUID);
    });

    it("should throw 401 without credentials", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(stored);

      await expect(
        bookingService.getByIdWithAccess(VALID_UUID, {})
      ).rejects.toThrow(AppError);
    });

    it("should throw 403 with a wrong token", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(stored);

      await expect(
        bookingService.getByIdWithAccess(VALID_UUID, { token: "wrong" })
      ).rejects.toThrow(AppError);
    });
  });

  describe("list", () => {
    it("should pass hotel/status/date filters to prisma", async () => {
      mockPrisma.booking.findMany.mockResolvedValue([]);

      await bookingService.list(
        {
          hotel_id: HOTEL_ID,
          status: "confirmed",
          date: "2026-10-02",
        },
        STAFF
      );

      expect(mockPrisma.booking.findMany).toHaveBeenCalledWith({
        where: {
          hotel_id: HOTEL_ID,
          status: "confirmed",
          check_in: { lte: new Date("2026-10-02") },
          check_out: { gte: new Date("2026-10-02") },
        },
        orderBy: { check_in: "asc" },
      });
    });

    it("should force the actor hotel even when another is requested", async () => {
      mockPrisma.booking.findMany.mockResolvedValue([]);

      await bookingService.list(
        { hotel_id: "ffffffff-ffff-4fff-bfff-ffffffffffff" },
        STAFF
      );

      expect(mockPrisma.booking.findMany).toHaveBeenCalledWith({
        where: { hotel_id: HOTEL_ID },
        orderBy: { check_in: "asc" },
      });
    });

    it("should reject non-staff roles", async () => {
      await expect(
        bookingService.list({}, { ...STAFF, role: "GUEST", hotel_id: null })
      ).rejects.toThrow(AppError);
      expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
    });
  });

  describe("confirm", () => {
    it("should reserve inventory and confirm a pending booking with staff access", async () => {
      mockReserve.mockResolvedValue({ reserved: true });
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce({
          booking_id: VALID_UUID,
          status: "pending",
          hotel_id: HOTEL_ID,
          version: 0,
          manage_token_hash: MANAGE_HASH,
          manage_token_expires_at: new Date(Date.now() + 3600_000),
          room_type_id: ROOM_TYPE_ID,
          check_in: new Date("2026-10-01"),
          check_out: new Date("2026-10-05"),
        })
        .mockResolvedValueOnce({ booking_id: VALID_UUID, status: "confirmed", version: 1 });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await bookingService.confirm(VALID_UUID, { actor: STAFF });

      expect(mockReserve).toHaveBeenCalledWith({
        ...EXPECTED_RANGE,
        idempotency_key: `booking:${VALID_UUID}:confirm`,
      });
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { booking_id: VALID_UUID, status: "pending", version: 0 },
        data: { status: "confirmed", version: { increment: 1 } },
      });
      expect(result.status).toBe("confirmed");
    });

    it("should confirm with the guest manage token", async () => {
      mockReserve.mockResolvedValue({ reserved: true });
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce({
          booking_id: VALID_UUID,
          status: "pending",
          hotel_id: HOTEL_ID,
          version: 0,
          manage_token_hash: MANAGE_HASH,
          manage_token_expires_at: new Date(Date.now() + 3600_000),
          room_type_id: ROOM_TYPE_ID,
          check_in: new Date("2026-10-01"),
          check_out: new Date("2026-10-05"),
        })
        .mockResolvedValueOnce({ booking_id: VALID_UUID, status: "confirmed", version: 1 });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await bookingService.confirm(VALID_UUID, {
        token: MANAGE_TOKEN,
      });

      expect(result.status).toBe("confirmed");
    });

    it("should throw 401 without credentials", async () => {
      await expect(bookingService.confirm(VALID_UUID, {})).rejects.toThrow(
        AppError
      );
      expect(mockReserve).not.toHaveBeenCalled();
    });

    it("should throw 404 when booking does not exist", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        bookingService.confirm(VALID_UUID, { actor: STAFF })
      ).rejects.toThrow(AppError);
      expect(mockReserve).not.toHaveBeenCalled();
    });

    it("should throw 409 when booking is not pending", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "confirmed",
        hotel_id: HOTEL_ID,
        version: 1,
        manage_token_hash: MANAGE_HASH,
        manage_token_expires_at: new Date(Date.now() + 3600_000),
      });

      await expect(
        bookingService.confirm(VALID_UUID, { actor: STAFF })
      ).rejects.toThrow(AppError);
      expect(mockReserve).not.toHaveBeenCalled();
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    });

    it("should throw 409 when rate service has no availability", async () => {
      mockReserve.mockRejectedValue(new AppError(409, "Insufficient availability", "Conflict"));
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        hotel_id: HOTEL_ID,
        version: 0,
        manage_token_hash: MANAGE_HASH,
        manage_token_expires_at: new Date(Date.now() + 3600_000),
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });

      await expect(
        bookingService.confirm(VALID_UUID, { actor: STAFF })
      ).rejects.toThrow(AppError);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    });

    it("should throw 502 when rate service is unavailable", async () => {
      mockReserve.mockRejectedValue(new AppError(502, "Rate & Availability Service unavailable", "Bad Gateway"));
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        hotel_id: HOTEL_ID,
        version: 0,
        manage_token_hash: MANAGE_HASH,
        manage_token_expires_at: new Date(Date.now() + 3600_000),
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });

      await expect(
        bookingService.confirm(VALID_UUID, { actor: STAFF })
      ).rejects.toThrow(AppError);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    });

    it("should compensate by releasing inventory on concurrent modification", async () => {
      mockReserve.mockResolvedValue({ reserved: true });
      mockRelease.mockResolvedValue({ released: true });
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        hotel_id: HOTEL_ID,
        version: 0,
        manage_token_hash: MANAGE_HASH,
        manage_token_expires_at: new Date(Date.now() + 3600_000),
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        bookingService.confirm(VALID_UUID, { actor: STAFF })
      ).rejects.toThrow(AppError);
      expect(mockRelease).toHaveBeenCalledWith({
        ...EXPECTED_RANGE,
        idempotency_key: `booking:${VALID_UUID}:confirm-compensate`,
      });
    });
  });

  describe("listByUser", () => {
    it("should return bookings created by the user or with their verified email", async () => {
      mockPrisma.booking.findMany.mockResolvedValue([
        { booking_id: VALID_UUID, manage_token_hash: MANAGE_HASH },
      ]);

      const result = await bookingService.listByUser(USER_ID, "ana@example.com", true);

      expect(mockPrisma.booking.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ booked_by_user_id: USER_ID }, { guest_email: "ana@example.com" }],
        },
        orderBy: { check_in: "asc" },
      });
      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty("manage_token_hash");
    });

    it("should not match by email when it is not verified", async () => {
      mockPrisma.booking.findMany.mockResolvedValue([]);

      await bookingService.listByUser(USER_ID, "victim@example.com", false);

      expect(mockPrisma.booking.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ booked_by_user_id: USER_ID }],
        },
        orderBy: { check_in: "asc" },
      });
    });
  });

  describe("manage token expiry", () => {
    it("should reject an expired manage token", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        hotel_id: HOTEL_ID,
        manage_token_hash: MANAGE_HASH,
        manage_token_expires_at: new Date(Date.now() - 1000),
      });

      await expect(
        bookingService.getByIdWithAccess(VALID_UUID, { token: MANAGE_TOKEN })
      ).rejects.toThrow(AppError);
    });
  });

  describe("cancel", () => {
    it("should release inventory and cancel a confirmed booking with staff access", async () => {
      mockRelease.mockResolvedValue({ released: true });
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "confirmed",
        hotel_id: HOTEL_ID,
        manage_token_hash: MANAGE_HASH,
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });
      mockPrisma.booking.update.mockResolvedValue({
        booking_id: VALID_UUID,
        hotel_id: HOTEL_ID,
        room_type_id: ROOM_TYPE_ID,
        status: "cancelled",
      });

      const result = await bookingService.cancel(VALID_UUID, { actor: STAFF });

      expect(mockRelease).toHaveBeenCalledWith({
        ...EXPECTED_RANGE,
        idempotency_key: `booking:${VALID_UUID}:cancel`,
      });
      expect(mockPrisma.booking.update).toHaveBeenCalledWith({
        where: { booking_id: VALID_UUID },
        data: { status: "cancelled" },
      });
      expect(result.status).toBe("cancelled");
      expect(mockPrisma.eventOutbox.create).toHaveBeenCalledWith({
        data: {
          event_type: "booking.cancelled",
          payload: {
            booking_id: VALID_UUID,
            hotel_id: HOTEL_ID,
            room_type_id: ROOM_TYPE_ID,
          },
        },
      });
    });

    it("should cancel with the guest manage token", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        hotel_id: HOTEL_ID,
        manage_token_hash: MANAGE_HASH,
      });
      mockPrisma.booking.update.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "cancelled",
        hotel_id: HOTEL_ID,
      });

      const result = await bookingService.cancel(VALID_UUID, {
        token: MANAGE_TOKEN,
      });

      expect(mockRelease).not.toHaveBeenCalled();
      expect(result.status).toBe("cancelled");
    });

    it("should throw 401 without credentials", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        hotel_id: HOTEL_ID,
        manage_token_hash: MANAGE_HASH,
      });

      await expect(bookingService.cancel(VALID_UUID, {})).rejects.toThrow(
        AppError
      );
      expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    });

    it("should throw 409 when already cancelled", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "cancelled",
        hotel_id: HOTEL_ID,
        manage_token_hash: MANAGE_HASH,
      });

      await expect(
        bookingService.cancel(VALID_UUID, { actor: STAFF })
      ).rejects.toThrow(AppError);
      expect(mockRelease).not.toHaveBeenCalled();
      expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    });
  });
});
