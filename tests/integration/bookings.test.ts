import request from "supertest";
import express from "express";
import bookingsRouter from "../../src/routes/bookings.js";
import { errorHandler, AppError } from "../../src/middleware/error-handler.js";

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

const app = express();
app.use(express.json());

// Health check route (mirrors index.ts)
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "booking-service",
  });
});

app.use("/v1/bookings", bookingsRouter);
app.use(errorHandler);

const VALID_UUID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const GUEST_ID = "b1b2c3d4-e5f6-4890-abcd-ef1234567890";
const HOTEL_ID = "c1b2c3d4-e5f6-4890-abcd-ef1234567890";
const ROOM_TYPE_ID = "d1b2c3d4-e5f6-4890-abcd-ef1234567890";

const validPayload = {
  guest_id: GUEST_ID,
  hotel_id: HOTEL_ID,
  room_type_id: ROOM_TYPE_ID,
  check_in: "2026-10-01",
  check_out: "2026-10-05",
  channel: "direct",
  total_amount: 25500,
};

describe("Booking Service API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /health", () => {
    it("should return health status", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("POST /v1/bookings", () => {
    it("should create a booking with valid data", async () => {
      mockPrisma.booking.create.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        ...validPayload,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });

      const res = await request(app).post("/v1/bookings").send(validPayload);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("pending");
    });

    it("should return 400 when check_out is not after check_in", async () => {
      const res = await request(app)
        .post("/v1/bookings")
        .send({ ...validPayload, check_out: "2026-10-01" });

      expect(res.status).toBe(400);
    });

    it("should return 400 with missing fields", async () => {
      const res = await request(app)
        .post("/v1/bookings")
        .send({ guest_id: GUEST_ID });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/bookings", () => {
    it("should return bookings list", async () => {
      mockPrisma.booking.findMany.mockResolvedValue([
        { booking_id: VALID_UUID, status: "pending" },
      ]);

      const res = await request(app).get("/v1/bookings");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("should return 400 with invalid status filter", async () => {
      const res = await request(app).get("/v1/bookings?status=weird");

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/bookings/:id", () => {
    it("should return a booking by id", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
      });

      const res = await request(app).get(`/v1/bookings/${VALID_UUID}`);
      expect(res.status).toBe(200);
    });

    it("should return 404 for non-existent booking", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      const res = await request(app).get(`/v1/bookings/${VALID_UUID}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /v1/bookings/:id/confirm", () => {
    it("should confirm a pending booking reserving inventory", async () => {
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

      const res = await request(app).post(`/v1/bookings/${VALID_UUID}/confirm`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("confirmed");
      expect(mockReserve).toHaveBeenCalled();
    });

    it("should return 409 when booking is not pending", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "cancelled",
        version: 0,
      });

      const res = await request(app).post(`/v1/bookings/${VALID_UUID}/confirm`);
      expect(res.status).toBe(409);
      expect(mockReserve).not.toHaveBeenCalled();
    });

    it("should return 409 when rate service has no availability", async () => {
      mockReserve.mockRejectedValue(
        new AppError(409, "Insufficient availability on 2026-10-01", "Conflict")
      );
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        version: 0,
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });

      const res = await request(app).post(`/v1/bookings/${VALID_UUID}/confirm`);
      expect(res.status).toBe(409);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("POST /v1/bookings/:id/cancel", () => {
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
        status: "cancelled",
      });

      const res = await request(app).post(`/v1/bookings/${VALID_UUID}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      expect(mockRelease).toHaveBeenCalled();
    });

    it("should return 409 when already cancelled", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "cancelled",
      });

      const res = await request(app).post(`/v1/bookings/${VALID_UUID}/cancel`);
      expect(res.status).toBe(409);
      expect(mockRelease).not.toHaveBeenCalled();
    });
  });
});
