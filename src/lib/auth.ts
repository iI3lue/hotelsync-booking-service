import { createHmac, timingSafeEqual } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";

export interface AuthClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  role: string;
  hotel_id: string | null;
  scope: "global" | "hotel";
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export const TOKEN_ISSUER = "hotelsync";
export const TOKEN_AUDIENCE = "hotelsync-api";

/**
 * Verificacion local de access tokens HS256 (misma firma que user-service).
 * Duplicado intencional por database-per-service: la implementacion canonica
 * vive en `services/user-service/src/lib/tokens.ts`.
 */
function getSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "test") {
    return "test-secret-for-unit-tests-only-32b!";
  }
  throw new Error("AUTH_JWT_SECRET must be set (min 32 chars)");
}

export function verifyAccessToken(token: string): AuthClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError(401, "Invalid token", "Unauthorized");
  }
  const [header, payload, signature] = parts;
  let decodedHeader: { alg?: string };
  try {
    decodedHeader = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8")
    );
  } catch {
    throw new AppError(401, "Invalid token", "Unauthorized");
  }
  if (decodedHeader.alg !== "HS256") {
    throw new AppError(401, "Invalid token", "Unauthorized");
  }
  const expected = createHmac("sha256", getSecret())
    .update(`${header}.${payload}`)
    .digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError(401, "Invalid token", "Unauthorized");
  }
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8")
  ) as AuthClaims;
  if (
    !claims.sub ||
    !claims.exp ||
    claims.iss !== TOKEN_ISSUER ||
    claims.aud !== TOKEN_AUDIENCE ||
    Date.now() / 1000 > claims.exp
  ) {
    throw new AppError(401, "Token expired", "Unauthorized");
  }
  return claims;
}

export interface AuthRequest extends Request {
  auth?: AuthClaims;
}

/** Claves independientes por caller backend; ninguna se entrega al browser. */
export function isTrustedService(req: Request): boolean {
  const callers = [
    { header: "x-front-desk-key", secret: process.env.FRONT_DESK_SERVICE_KEY },
    { header: "x-housekeeping-key", secret: process.env.HOUSEKEEPING_SERVICE_KEY },
    { header: "x-billing-key", secret: process.env.BILLING_SERVICE_KEY },
    { header: "x-user-key", secret: process.env.USER_SERVICE_KEY },
    // payment-service: verifica el total y el dueño antes de cobrar.
    { header: "x-payment-key", secret: process.env.PAYMENT_SERVICE_KEY },
    // loyalty-service: lee la reserva para acreditar puntos (earn).
    { header: "x-loyalty-key", secret: process.env.LOYALTY_SERVICE_KEY },
    {
      header: "x-channel-manager-key",
      secret: process.env.CHANNEL_MANAGER_SERVICE_KEY,
    },
  ];
  return callers.some(({ header, secret }) => {
    if (!secret) return false;
    const value = req.headers[header];
    const provided = Array.isArray(value) ? value[0] : value;
    if (!provided) return false;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(secret, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Ingesta Channel Manager: service key dedicada (`x-channel-manager-key`).
 * Solo este caller puede crear reservas `ota:*`; el par anónimo +
 * `manage_token` queda reservado a huéspedes web. Nunca al browser.
 */
export function isChannelManager(req: Request): boolean {
  const secret = process.env.CHANNEL_MANAGER_SERVICE_KEY;
  if (!secret) return false;
  const value = req.headers["x-channel-manager-key"];
  const provided = Array.isArray(value) ? value[0] : value;
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Reserva POST /bookings para el canal si el body declara un canal OTA.
 * Se monta antes de Zod para que una petición OTA sin credenciales reciba
 * 401 aunque el payload también esté mal formado.
 */
export function requireChannelManagerForOta(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const channel = (req.body as { channel?: unknown } | undefined)?.channel;
  if (typeof channel === "string" && channel.startsWith("ota:") && !isChannelManager(req)) {
    next(
      new AppError(
        401,
        "Channel ingestion requires channel-manager credentials",
        "Unauthorized"
      )
    );
    return;
  }
  next();
}

/**
 * Exige service key de un caller backend (server-to-server, sin JWT de
 * usuario). Para endpoints consumidos por otros microservicios.
 */
export function requireTrustedService(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!isTrustedService(req)) {
    next(new AppError(401, "Missing service credentials", "Unauthorized"));
    return;
  }
  next();
}

/** Exige uno de los roles indicados (requiere `requireAuth` antes). */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = (req as AuthRequest).auth;
    if (!auth) {
      next(new AppError(401, "Missing bearer token", "Unauthorized"));
      return;
    }
    if (!roles.includes(auth.role)) {
      next(new AppError(403, "Insufficient role", "Forbidden"));
      return;
    }
    next();
  };
}

/** Exige un access token valido y lo deja en `req.auth`. */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new AppError(401, "Missing bearer token", "Unauthorized");
    }
    (req as AuthRequest).auth = verifyAccessToken(
      header.slice("Bearer ".length).trim()
    );
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Adjunta el actor si hay un Bearer valido; sin token sigue anonimo.
 * Para el alta anonima con `booked_by_user_id` opcional.
 */
export function attachAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      (req as AuthRequest).auth = verifyAccessToken(
        header.slice("Bearer ".length).trim()
      );
    }
    next();
  } catch {
    next();
  }
}
