import { Request, Response, NextFunction } from "express";
import { bookingService } from "../services/booking.service.js";

export class BookingController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const bookings = await bookingService.list(req.query as never);
      res.json(bookings);
    } catch (err) {
      next(err);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const booking = await bookingService.findById(id);
      res.json(booking);
    } catch (err) {
      next(err);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const booking = await bookingService.create(req.body);
      res.status(201).json(booking);
    } catch (err) {
      next(err);
    }
  }

  async confirm(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const booking = await bookingService.confirm(id);
      res.json(booking);
    } catch (err) {
      next(err);
    }
  }

  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const booking = await bookingService.cancel(id);
      res.json(booking);
    } catch (err) {
      next(err);
    }
  }
}

export const bookingController = new BookingController();
