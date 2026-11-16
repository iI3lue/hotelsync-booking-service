import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

const DEV_SECRET_MARKERS = ["change-me", "hotelsync-dev-", "replace-with-"];
const MIN_GATEWAY_SECRET_LENGTH = 32;

/** Render expone RENDER/RENDER_SERVICE_ID; el Docker local no. */
export function isDeployed(): boolean {
  return process.env.RENDER === "true" || Boolean(process.env.RENDER_SERVICE_ID);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Corta el arranque si en produccion sobreviven secretos de ejemplo del repo.
 * Sin este guard, un env faltante deja JWT/claves de servicio con valores
 * publicos: cualquiera podria forjar tokens o llamar a los servicios.
 */
export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (!isDeployed()) return;

  const offenders: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/(_SECRET|_KEY)$/.test(name)) continue;
    if (DEV_SECRET_MARKERS.some((marker) => value.includes(marker))) {
      offenders.push(name);
    }
  }

  const gatewaySecret = env.GATEWAY_SECRET;
  if (gatewaySecret && gatewaySecret.length < MIN_GATEWAY_SECRET_LENGTH) {
    offenders.push("GATEWAY_SECRET(<32 chars)");
  }

  if (offenders.length > 0) {
    console.error(
      `[security] refusing to start: insecure default secrets in ${offenders.join(", ")}`
    );
    process.exit(1);
  }
}

/**
 * `/metrics` exige METRICS_TOKEN. En Render sin token configurado responde 404
 * (no revela la existencia del endpoint); en local queda abierto para el
 * flujo de desarrollo y los tests.
 */
export function metricsGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = process.env.METRICS_TOKEN ?? "";
    if (!token) {
      if (isDeployed()) {
        res.status(404).json({
          error: "NotFound",
          message: "Ruta no encontrada",
          statusCode: 404,
        });
        return;
      }
      next();
      return;
    }

    const authorization = req.header("authorization") ?? "";
    const provided = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : req.header("x-metrics-token") ?? "";

    if (safeEqual(provided, token)) {
      next();
      return;
    }

    res.status(401).json({
      error: "Unauthorized",
      message: "Metrics token required",
      statusCode: 401,
    });
  };
}

export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

/**
 * IP real del cliente. `x-client-ip` solo cuenta si la peticion paso por el
 * gateway con secreto valido; si no, se usa la IP de la conexion (evita
 * spoofing directo contra la URL publica del servicio).
 */
export function clientIp(
  req: Request,
  res: Response,
  fallback = "unknown"
): string {
  if (res.locals.gatewayAuthenticated === true) {
    const forwarded = req.header("x-client-ip");
    if (forwarded) return forwarded;
  }
  return req.ip ?? req.socket.remoteAddress ?? fallback;
}
