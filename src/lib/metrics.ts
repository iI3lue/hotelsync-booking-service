import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { NextFunction, Request, Response } from "express";
import prisma from "./prisma.js";
import { broker } from "./broker.js";

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: "hotelsync_" });

const httpRequestDuration = new Histogram({
  name: "hotelsync_http_request_duration_seconds",
  help: "Duración de las peticiones HTTP en segundos",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const httpRequestsTotal = new Counter({
  name: "hotelsync_http_requests_total",
  help: "Total de peticiones HTTP",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

const httpRequestsInFlight = new Gauge({
  name: "hotelsync_http_requests_in_flight",
  help: "Peticiones HTTP en curso",
  registers: [registry],
});

const outboxPending = new Gauge({
  name: "hotelsync_outbox_pending_events",
  help: "Eventos del outbox pendientes de publicar",
  registers: [registry],
  async collect() {
    try {
      outboxPending.set(await prisma.eventOutbox.count({ where: { status: "pending" } }));
    } catch {
      outboxPending.set(Number.NaN);
    }
  },
});

const brokerConnected = new Gauge({
  name: "hotelsync_broker_connected",
  help: "1 si el broker RabbitMQ está conectado, 0 si no",
  registers: [registry],
  collect() {
    brokerConnected.set(broker.isConnected() ? 1 : 0);
  },
});

const ROUTE_PREFIXES = ["/v1/bookings"];

function routeLabel(req: Request): string {
  const urlPath = req.originalUrl.split("?")[0];
  const routePath = (req as Request & { route?: { path?: string } }).route?.path;
  const prefix =
    ROUTE_PREFIXES.find((p) => urlPath === p || urlPath.startsWith(`${p}/`)) ?? "";
  if (!routePath) return prefix || "unmatched";
  const full = `${prefix}${routePath}`.replace(/\/+/g, "/");
  return full.length > 1 ? full.replace(/\/$/, "") : full || "/";
}

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/metrics") return next();

  httpRequestsInFlight.inc();
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status: String(res.statusCode),
    };
    httpRequestDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
    httpRequestsTotal.inc(labels);
    httpRequestsInFlight.dec();
  });

  next();
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader("Content-Type", registry.contentType);
  res.end(await registry.metrics());
}
