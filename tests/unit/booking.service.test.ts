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
const GUEST_ID = "b1b2c3d4-e5f6-4890-abcd-ef1234567890";
const HOTEL_ID = "c1b2c3d4-e5f6-4890-abcd-ef1234567890";
const ROOM_TYPE_ID = "d1b2c3d4-e5f6-4890-abcd-ef1234567890";

const EXPECTED_RANGE = {
  room_type_id: ROOM_TYPE_ID,
  check_in: "2026-10-01",
  check_out: "2026-10-05",
};

const baseInput = {
  guest_id: GUEST_ID,
  hotel_id: HOTEL_ID,
  room_type_id: ROOM_TYPE_ID,
  check_in: "2026-10-01",
  check_out: "2026-10-05",
  channel: "direct" as const,
  total_amount: 25500,
};

describe("BookingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("create", () => {
    it("should create a pending booking and enqueue booking.created in the same transaction", async () => {
      const created = {
        booking_id: VALID_UUID,
        status: "pending",
        ...baseInput,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      };
      mockPrisma.booking.create.mockResolvedValue(created);

      const result = await bookingService.create(baseInput);

      expect(result).toEqual(created);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.booking.create).toHaveBeenCalledWith({
        data: {
          guest_id: GUEST_ID,
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
            guest_id: GUEST_ID,
            hotel_id: HOTEL_ID,
            room_type_id: ROOM_TYPE_ID,
            check_in: "2026-10-01",
            check_out: "2026-10-05",
            channel: "direct",
          },
        },
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

  describe("list", () => {
    it("should pass hotel/status/date filters to prisma", async () => {
      mockPrisma.booking.findMany.mockResolvedValue([]);

      await bookingService.list({
        hotel_id: HOTEL_ID,
        status: "confirmed",
        date: "2026-10-02",
      });

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
  });

  describe("confirm", () => {
    it("should reserve inventory and confirm a pending booking", async () => {
      mockReserve.mockResolvedValue({ reserved: true });
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce({
          booking_id: VALID_UUID,
          status: "pending",
          version: 0,
          room_type_id: ROOM_TYPE_ID,
          check_in: new Date("2026-10-01"),
          check_out: new Date("2026-10-05"),
        })
        .mockResolvedValueOnce({ booking_id: VALID_UUID, status: "confirmed", version: 1 });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await bookingService.confirm(VALID_UUID);

      expect(mockReserve).toHaveBeenCalledWith(EXPECTED_RANGE);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { booking_id: VALID_UUID, status: "pending", version: 0 },
        data: { status: "confirmed", version: { increment: 1 } },
      });
      expect(result.status).toBe("confirmed");
    });

    it("should throw 404 when booking does not exist", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(bookingService.confirm(VALID_UUID)).rejects.toThrow(
        AppError
      );
      expect(mockReserve).not.toHaveBeenCalled();
    });

    it("should throw 409 when booking is not pending", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "confirmed",
        version: 1,
      });

      await expect(bookingService.confirm(VALID_UUID)).rejects.toThrow(
        AppError
      );
      expect(mockReserve).not.toHaveBeenCalled();
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    });

    it("should throw 409 when rate service has no availability", async () => {
      mockReserve.mockRejectedValue(new AppError(409, "Insufficient availability", "Conflict"));
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        version: 0,
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });

      await expect(bookingService.confirm(VALID_UUID)).rejects.toThrow(
        AppError
      );
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockRelease).not.toHaveBeenCalled();
    });

    it("should throw 502 when rate service is unavailable", async () => {
      mockReserve.mockRejectedValue(new AppError(502, "Rate & Availability Service unavailable", "Bad Gateway"));
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        version: 0,
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });

      await expect(bookingService.confirm(VALID_UUID)).rejects.toThrow(
        AppError
      );
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    });

    it("should compensate by releasing inventory on concurrent modification", async () => {
      mockReserve.mockResolvedValue({ reserved: true });
      mockRelease.mockResolvedValue({ released: true });
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        version: 0,
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });

      await expect(bookingService.confirm(VALID_UUID)).rejects.toThrow(
        AppError
      );
      expect(mockRelease).toHaveBeenCalledWith(EXPECTED_RANGE);
    });
  });

  describe("cancel", () => {
    it("should release inventory and cancel a confirmed booking", async () => {
      mockRelease.mockResolvedValue({ released: true });
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "confirmed",
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

      const result = await bookingService.cancel(VALID_UUID);

      expect(mockRelease).toHaveBeenCalledWith(EXPECTED_RANGE);
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

    it("should not release inventory for a pending booking", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
      });
      mockPrisma.booking.update.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "cancelled",
      });

      const result = await bookingService.cancel(VALID_UUID);

      expect(mockRelease).not.toHaveBeenCalled();
      expect(result.status).toBe("cancelled");
    });

    it("should throw 409 when already cancelled", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "cancelled",
      });

      await expect(bookingService.cancel(VALID_UUID)).rejects.toThrow(
        AppError
      );
      expect(mockRelease).not.toHaveBeenCalled();
      expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    });
  });
});
