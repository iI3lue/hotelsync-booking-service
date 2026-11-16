import express from "express";
import request from "supertest";
import { clientIp, metricsGuard } from "../../src/lib/security.js";

const ENV_KEYS = ["RENDER", "RENDER_SERVICE_ID", "METRICS_TOKEN"] as const;
const ORIGINAL_ENV = { ...process.env };

function appWithMetrics() {
  const app = express();
  app.get("/metrics", metricsGuard(), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

describe("metricsGuard", () => {
  it("keeps /metrics open outside a deployment when no token is set", async () => {
    delete process.env.RENDER;
    delete process.env.RENDER_SERVICE_ID;
    delete process.env.METRICS_TOKEN;

    const res = await request(appWithMetrics()).get("/metrics");

    expect(res.status).toBe(200);
  });

  it("returns 404 on a deployment without METRICS_TOKEN", async () => {
    process.env.RENDER = "true";
    delete process.env.METRICS_TOKEN;

    const res = await request(appWithMetrics()).get("/metrics");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404 });
  });

  it("requires the bearer token when METRICS_TOKEN is configured", async () => {
    process.env.RENDER = "true";
    process.env.METRICS_TOKEN = "metrics-token-0123456789";

    const unauthorized = await request(appWithMetrics()).get("/metrics");
    expect(unauthorized.status).toBe(401);

    const wrong = await request(appWithMetrics())
      .get("/metrics")
      .set("Authorization", "Bearer nope");
    expect(wrong.status).toBe(401);

    const bearer = await request(appWithMetrics())
      .get("/metrics")
      .set("Authorization", "Bearer metrics-token-0123456789");
    expect(bearer.status).toBe(200);

    const header = await request(appWithMetrics())
      .get("/metrics")
      .set("x-metrics-token", "metrics-token-0123456789");
    expect(header.status).toBe(200);
  });
});

describe("clientIp", () => {
  function ipApp() {
    const app = express();
    app.set("trust proxy", 1);
    app.use((req, res, next) => {
      res.locals.gatewayAuthenticated = req.query.trusted === "1";
      next();
    });
    app.get("/ip", (req, res) => {
      res.json({ ip: clientIp(req, res) });
    });
    return app;
  }

  it("trusts x-client-ip after a valid gateway secret", async () => {
    const res = await request(ipApp())
      .get("/ip?trusted=1")
      .set("x-client-ip", "203.0.113.9");

    expect(res.body.ip).toBe("203.0.113.9");
  });

  it("ignores x-client-ip on direct calls", async () => {
    const res = await request(ipApp())
      .get("/ip")
      .set("x-client-ip", "203.0.113.9");

    expect(res.body.ip).not.toBe("203.0.113.9");
  });
});
