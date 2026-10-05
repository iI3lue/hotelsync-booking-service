import { Router } from "express";
import { bookingController } from "../controllers/booking.controller.js";
import { attachAuth, requireAuth, requireRole } from "../lib/auth.js";
import { validate } from "../middleware/validate.js";
import {
  bookingIdParamSchema,
  createBookingSchema,
  listBookingsQuerySchema,
  manageTokenQuerySchema,
} from "../validators/booking.js";

const router = Router();

const requireStaff = requireRole("SUPER_ADMIN", "MANAGER", "RECEPTIONIST");

router.get(
  "/",
  requireAuth,
  requireStaff,
  validate(listBookingsQuerySchema, "query"),
  bookingController.list.bind(bookingController)
);
router.post(
  "/",
  attachAuth,
  validate(createBookingSchema),
  bookingController.create.bind(bookingController)
);
router.get(
  "/me",
  requireAuth,
  bookingController.listMine.bind(bookingController)
);
router.get(
  "/:id",
  attachAuth,
  validate(bookingIdParamSchema, "params"),
  validate(manageTokenQuerySchema, "query"),
  bookingController.getById.bind(bookingController)
);
router.post(
  "/:id/confirm",
  attachAuth,
  validate(bookingIdParamSchema, "params"),
  validate(manageTokenQuerySchema, "query"),
  bookingController.confirm.bind(bookingController)
);
router.post(
  "/:id/cancel",
  attachAuth,
  validate(bookingIdParamSchema, "params"),
  validate(manageTokenQuerySchema, "query"),
  bookingController.cancel.bind(bookingController)
);

export default router;
