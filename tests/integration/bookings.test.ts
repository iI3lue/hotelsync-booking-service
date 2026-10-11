import { createHash } from "node:crypto";
import request from "supertest";
import express from "express";
import bookingsRouter from "../../src/routes/bookings.js";
import { errorHandler, AppError } from "../../src/middleware/error-handler.js";
import { signAccessToken } from "../../../user-service/src/lib/tokens.js";

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
    inventoryReservationAttempt: {
      upsert: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
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
process.env.FRONT_DESK_SERVICE_KEY = "test-front-desk-key";
process.env.HOUSEKEEPING_SERVICE_KEY = "test-housekeeping-key";
process.env.BILLING_SERVICE_KEY = "test-billing-key";
process.env.CHANNEL_MANAGER_SERVICE_KEY = "test-channel-manager-key";
process.env.CHANNEL_MANAGER_MANAGE_TOKEN_SECRET =
  "test-channel-manage-token-secret-32b!";

// $transaction interactiva: passthrough al mismo mock (tx === prisma mockeado)
mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
mockPrisma.inventoryReservationAttempt.upsert.mockImplementation(
  async ({ create }: any) => create
);

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
const HOTEL_ID = "c1b2c3d4-e5f6-4890-abcd-ef1234567890";
const ROOM_TYPE_ID = "d1b2c3d4-e5f6-4890-abcd-ef1234567890";

const MANAGE_TOKEN = "guest-manage-token";
const MANAGE_HASH = createHash("sha256").update(MANAGE_TOKEN).digest("hex");

const validPayload = {
  hotel_id: HOTEL_ID,
  room_type_id: ROOM_TYPE_ID,
  check_in: "2026-10-01",
  check_out: "2026-10-05",
  channel: "direct",
  total_amount: 25500,
  guest: { name: "Ana", email: "ana@example.com", phone: "+5491112345678" },
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
    it("should create an anonymous booking with server-generated ids", async () => {
      mockPrisma.booking.create.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        guest_id: "generated-guest-id",
        ...validPayload,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });

      const res = await request(app).post("/v1/bookings").send(validPayload);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("pending");
      expect(res.body.manage_token).toHaveLength(64);
      expect(res.body).not.toHaveProperty("manage_token_hash");
    });

    it("should return 400 when check_out is not after check_in", async () => {
      const res = await request(app)
        .post("/v1/bookings")
        .send({ ...validPayload, check_out: "2026-10-01" });

      expect(res.status).toBe(400);
    });

    it("should return 400 with missing guest data", async () => {
      const res = await request(app)
        .post("/v1/bookings")
        .send({ hotel_id: HOTEL_ID });

      expect(res.status).toBe(400);
    });

    it("should require Channel Manager credentials for OTA intake", async () => {
      const res = await request(app)
        .post("/v1/bookings")
        .send({
          ...validPayload,
          channel: "ota:simulado",
          channel_external_id: "external-1",
        });

      expect(res.status).toBe(401);
    });

    it("should require an external id for OTA bookings", async () => {
      const res = await request(app)
        .post("/v1/bookings")
        .set("x-channel-manager-key", process.env.CHANNEL_MANAGER_SERVICE_KEY!)
        .send({ ...validPayload, channel: "ota:simulado" });

      expect(res.status).toBe(400);
    });

    it("should replay an OTA booking idempotently and return the same manage token", async () => {
      const otaPayload = {
        ...validPayload,
        channel: "ota:simulado",
        channel_external_id: "external-1",
      };
      const created = {
        booking_id: VALID_UUID,
        status: "pending",
        guest_id: "generated-guest-id",
        guest_name: "Ana",
        ...otaPayload,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      };
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(created);
      mockPrisma.booking.create.mockResolvedValue(created);

      const first = await request(app)
        .post("/v1/bookings")
        .set("x-channel-manager-key", process.env.CHANNEL_MANAGER_SERVICE_KEY!)
        .send(otaPayload);
      const replay = await request(app)
        .post("/v1/bookings")
        .set("x-channel-manager-key", process.env.CHANNEL_MANAGER_SERVICE_KEY!)
        .send(otaPayload);

      expect(first.status).toBe(201);
      expect(first.body.created).toBe(true);
      expect(replay.status).toBe(200);
      expect(replay.body.created).toBe(false);
      expect(replay.body.booking_id).toBe(first.body.booking_id);
      expect(replay.body.manage_token).toBe(first.body.manage_token);
      expect(mockPrisma.booking.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.eventOutbox.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("GET /v1/bookings", () => {
    const STAFF_TOKEN = signAccessToken({
      sub: "11111111-2222-4333-8444-555555555555",
      email: "recep@example.com",
      role: "RECEPTIONIST",
      hotel_id: HOTEL_ID,
    });

    it("should return bookings list for staff of the hotel", async () => {
      mockPrisma.booking.findMany.mockResolvedValue([
        { booking_id: VALID_UUID, status: "pending" },
      ]);

      const res = await request(app)
        .get("/v1/bookings")
        .set("Authorization", `Bearer ${STAFF_TOKEN}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("should return 401 without credentials", async () => {
      const res = await request(app).get("/v1/bookings");

      expect(res.status).toBe(401);
    });

    it("should return 400 with invalid status filter", async () => {
      const res = await request(app)
        .get("/v1/bookings?status=weird")
        .set("Authorization", `Bearer ${STAFF_TOKEN}`);

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/bookings/:id", () => {
    it("should return a booking with its manage token", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        manage_token_hash: MANAGE_HASH,
      });

      const res = await request(app).get(
        `/v1/bookings/${VALID_UUID}?token=${MANAGE_TOKEN}`
      );
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("manage_token_hash");
    });

    it("should return 401 without credentials", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "pending",
        manage_token_hash: MANAGE_HASH,
      });

      const res = await request(app).get(`/v1/bookings/${VALID_UUID}`);
      expect(res.status).toBe(401);
    });

    it("should allow the authenticated Front Desk service", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "confirmed",
        manage_token_hash: MANAGE_HASH,
      });

      const res = await request(app)
        .get(`/v1/bookings/${VALID_UUID}`)
        .set("x-front-desk-key", "test-front-desk-key");

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("manage_token_hash");
    });

    it("should return 404 for non-existent booking", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      const res = await request(app).get(
        `/v1/bookings/${VALID_UUID}?token=${MANAGE_TOKEN}`
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /v1/bookings/:id/confirm", () => {
    it("should confirm a pending booking with the manage token", async () => {
      mockReserve.mockResolvedValue({ reserved: true });
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce({
          booking_id: VALID_UUID,
          status: "pending",
          version: 0,
          manage_token_hash: MANAGE_HASH,
          manage_token_expires_at: new Date(Date.now() + 3600_000),
          room_type_id: ROOM_TYPE_ID,
          check_in: new Date("2026-10-01"),
          check_out: new Date("2026-10-05"),
        })
        .mockResolvedValueOnce({ booking_id: VALID_UUID, status: "confirmed", version: 1 });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const res = await request(app).post(
        `/v1/bookings/${VALID_UUID}/confirm?token=${MANAGE_TOKEN}`
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("confirmed");
      expect(mockReserve).toHaveBeenCalled();
    });

    it("should return 401 without credentials", async () => {
      const res = await request(app).post(`/v1/bookings/${VALID_UUID}/confirm`);
      expect(res.status).toBe(401);
      expect(mockReserve).not.toHaveBeenCalled();
    });

    it("should return 409 when booking is not pending", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "cancelled",
        version: 0,
        manage_token_hash: MANAGE_HASH,
        manage_token_expires_at: new Date(Date.now() + 3600_000),
      });

      const res = await request(app).post(
        `/v1/bookings/${VALID_UUID}/confirm?token=${MANAGE_TOKEN}`
      );
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
        manage_token_hash: MANAGE_HASH,
        manage_token_expires_at: new Date(Date.now() + 3600_000),
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });

      const res = await request(app).post(
        `/v1/bookings/${VALID_UUID}/confirm?token=${MANAGE_TOKEN}`
      );
      expect(res.status).toBe(409);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("GET /v1/bookings/me", () => {
    it("should return 401 without a session", async () => {
      const res = await request(app).get("/v1/bookings/me");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /v1/bookings/:id/cancel", () => {
    it("should release inventory and cancel with the manage token", async () => {
      mockRelease.mockResolvedValue({ released: true });
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "confirmed",
        manage_token_hash: MANAGE_HASH,
        room_type_id: ROOM_TYPE_ID,
        check_in: new Date("2026-10-01"),
        check_out: new Date("2026-10-05"),
      });
      mockPrisma.booking.update.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "cancelled",
      });

      const res = await request(app).post(
        `/v1/bookings/${VALID_UUID}/cancel?token=${MANAGE_TOKEN}`
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("cancelled");
      expect(mockRelease).toHaveBeenCalled();
    });

    it("should return 401 without credentials", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "confirmed",
        manage_token_hash: MANAGE_HASH,
      });

      const res = await request(app).post(`/v1/bookings/${VALID_UUID}/cancel`);
      expect(res.status).toBe(401);
      expect(mockRelease).not.toHaveBeenCalled();
    });

    it("should return 409 when already cancelled", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        booking_id: VALID_UUID,
        status: "cancelled",
        manage_token_hash: MANAGE_HASH,
      });

      const res = await request(app).post(
        `/v1/bookings/${VALID_UUID}/cancel?token=${MANAGE_TOKEN}`
      );
      expect(res.status).toBe(409);
      expect(mockRelease).not.toHaveBeenCalled();
    });
  });
});
