import { Request, Response, NextFunction } from "express";
import { bookingService, BookingAccess } from "../services/booking.service.js";
import { AuthRequest, isTrustedService } from "../lib/auth.js";

function accessFrom(req: Request): BookingAccess {
  // El token viaja preferentemente en header: en query queda en logs,
  // historial y referrers. Se mantiene query por compatibilidad.
  const headerToken = req.headers["x-manage-token"];
  return {
    actor: (req as AuthRequest).auth,
    serviceAuthorized: isTrustedService(req),
    token:
      (Array.isArray(headerToken) ? headerToken[0] : headerToken) ??
      (req.query as { token?: string }).token,
  };
}

export class BookingController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const auth = (req as AuthRequest).auth;
      const bookings = await bookingService.list(
        req.query as never,
        auth ?? {
          sub: "",
          email: "",
          email_verified: false,
          role: "",
          hotel_id: null,
          scope: "global",
          iss: "",
          aud: "",
          iat: 0,
          exp: 0,
        }
      );
      res.json(bookings);
    } catch (err) {
      next(err);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const booking = await bookingService.getByIdWithAccess(
        id,
        accessFrom(req)
      );
      res.json(booking);
    } catch (err) {
      next(err);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = (req as AuthRequest).auth;
      const booking = await bookingService.create(req.body, actor);
      res.status(201).json(booking);
    } catch (err) {
      next(err);
    }
  }

  async confirm(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const booking = await bookingService.confirm(id, accessFrom(req));
      res.json(booking);
    } catch (err) {
      next(err);
    }
  }

  async listMine(req: Request, res: Response, next: NextFunction) {
    try {
      const auth = (req as AuthRequest).auth;
      const bookings = await bookingService.listByUser(
        auth?.sub as string,
        auth?.email as string,
        auth?.email_verified ?? false
      );
      res.json(bookings);
    } catch (err) {
      next(err);
    }
  }

  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const booking = await bookingService.cancel(id, accessFrom(req));
      res.json(booking);
    } catch (err) {
      next(err);
    }
  }
}

export const bookingController = new BookingController();
