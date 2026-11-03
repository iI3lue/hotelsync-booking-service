import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Exige que el tráfico entrante pruebe que pasó por el api-gateway (o que lo
 * envía otro servicio de HotelSync) mediante la cabecera `x-gateway-secret`.
 *
 * Variables de entorno (se leen en cada request, sin reiniciar el proceso
 * de tests):
 *  - GATEWAY_SECRET           secreto compartido. Vacío => verificación apagada.
 *  - GATEWAY_SECRET_PREVIOUS  opcional; se acepta durante una rotación.
 *  - GATEWAY_MODE             "warn" (por defecto) solo registra; "enforce" responde 401.
 *
 * `/health` queda exento para los health checks de Render y el wake-up del gateway.
 * No sustituye la validación de JWT ni de claves de servicio de cada ruta.
 */
type Mode = "off" | "warn" | "enforce";

function currentMode(): Mode {
  if (!process.env.GATEWAY_SECRET) return "off";
  return process.env.GATEWAY_MODE === "enforce" ? "enforce" : "warn";
}

function equalsSecret(provided: unknown, expected: string | undefined): boolean {
  if (typeof provided !== "string" || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

let announced = false;
let lastWarnAt = 0;
let missesSinceWarn = 0;

function announce(mode: Mode): void {
  if (announced) return;
  announced = true;
  console.log(`[gateway] verificación de x-gateway-secret: modo=${mode}`);
}

function logMiss(req: Request): void {
  missesSinceWarn += 1;
  const now = Date.now();
  if (now - lastWarnAt < 10_000) return;
  console.warn(
    `[gateway] ${missesSinceWarn} request(s) sin x-gateway-secret válido; último: ${JSON.stringify(
      `${req.method} ${req.path}`
    )}`
  );
  lastWarnAt = now;
  missesSinceWarn = 0;
}

export function requireGateway(req: Request, res: Response, next: NextFunction): void {
  const mode = currentMode();
  announce(mode);
  if (mode === "off" || req.path === "/health") return next();

  const provided = req.headers["x-gateway-secret"];
  if (
    equalsSecret(provided, process.env.GATEWAY_SECRET) ||
    equalsSecret(provided, process.env.GATEWAY_SECRET_PREVIOUS)
  ) {
    return next();
  }

  if (mode === "warn") {
    logMiss(req);
    return next();
  }

  res.status(401).json({
    error: "Unauthorized",
    message: "Gateway credentials required",
    statusCode: 401,
  });
}

/** Cabeceras que deben llevar las llamadas salientes hacia otros servicios. */
export function gatewayHeaders(): Record<string, string> {
  const secret = process.env.GATEWAY_SECRET;
  return secret ? { "x-gateway-secret": secret } : {};
}
