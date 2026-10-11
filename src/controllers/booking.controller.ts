import { Request, Response, NextFunction } from "express";
import { bookingService, BookingAccess } from "../services/booking.service.js";
import {
  AuthRequest,
  isChannelManager,
  isTrustedService,
} from "../lib/auth.js";
import { AppError } from "../middleware/error-handler.js";

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
      // Ingesta de canales: los `ota:*` exigen la service key de Channel
      // Manager. El canal se lee crudo acá (pre-validación Zod) solo para
      // decidir la puerta; el formato lo valida el schema después.
      const rawChannel = (req.body as { channel?: unknown })?.channel;
      if (
        typeof rawChannel === "string" &&
        rawChannel.startsWith("ota:") &&
        !isChannelManager(req)
      ) {
        throw new AppError(
          401,
          "Channel ingestion requires channel-manager credentials",
          "Unauthorized"
        );
      }
      const actor = (req as AuthRequest).auth;
      const booking = await bookingService.create(req.body, actor);
      res.status(booking.created ? 201 : 200).json(booking);
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
