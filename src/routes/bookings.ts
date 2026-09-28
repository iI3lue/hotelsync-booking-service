import { Router } from "express";
import { bookingController } from "../controllers/booking.controller.js";
import { validate } from "../middleware/validate.js";
import {
  bookingIdParamSchema,
  createBookingSchema,
  listBookingsQuerySchema,
} from "../validators/booking.js";

const router = Router();

router.get(
  "/",
  validate(listBookingsQuerySchema, "query"),
  bookingController.list.bind(bookingController)
);
router.post(
  "/",
  validate(createBookingSchema),
  bookingController.create.bind(bookingController)
);
router.get(
  "/:id",
  validate(bookingIdParamSchema, "params"),
  bookingController.getById.bind(bookingController)
);
router.post(
  "/:id/confirm",
  validate(bookingIdParamSchema, "params"),
  bookingController.confirm.bind(bookingController)
);
router.post(
  "/:id/cancel",
  validate(bookingIdParamSchema, "params"),
  bookingController.cancel.bind(bookingController)
);

export default router;
