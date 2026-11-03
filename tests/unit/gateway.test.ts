import { requireGateway, gatewayHeaders } from "../../src/middleware/gateway.js";

const SECRET = "s".repeat(40);

function run(headers: Record<string, unknown>, path = "/v1/algo") {
  const req: any = { headers, path, method: "GET" };
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const next = jest.fn();
  requireGateway(req, res, next);
  return { res, next };
}

describe("requireGateway", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.GATEWAY_SECRET;
    delete process.env.GATEWAY_SECRET_PREVIOUS;
    delete process.env.GATEWAY_MODE;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  it("sin GATEWAY_SECRET está apagado y deja pasar todo", () => {
    const { next, res } = run({});
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it("con secreto y sin modo explícito funciona en warn: deja pasar y registra", () => {
    process.env.GATEWAY_SECRET = SECRET;
    const { next, res } = run({});
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  describe("enforce", () => {
    beforeEach(() => {
      process.env.GATEWAY_SECRET = SECRET;
      process.env.GATEWAY_MODE = "enforce";
    });

    it("rechaza sin cabecera (401)", () => {
      const { next, res } = run({});
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        error: "Unauthorized",
        message: "Gateway credentials required",
        statusCode: 401,
      });
    });

    it("rechaza un secreto incorrecto (401)", () => {
      const { next, res } = run({ "x-gateway-secret": "otro-valor" });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it("rechaza una cabecera repetida (array)", () => {
      const { next, res } = run({ "x-gateway-secret": [SECRET, SECRET] });
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it("acepta el secreto correcto", () => {
      const { next } = run({ "x-gateway-secret": SECRET });
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("acepta GATEWAY_SECRET_PREVIOUS durante una rotación", () => {
      process.env.GATEWAY_SECRET_PREVIOUS = "p".repeat(40);
      const { next } = run({ "x-gateway-secret": "p".repeat(40) });
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("deja /health sin secreto", () => {
      const { next } = run({}, "/health");
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});

describe("gatewayHeaders", () => {
  afterEach(() => {
    delete process.env.GATEWAY_SECRET;
  });

  it("devuelve la cabecera solo si hay secreto configurado", () => {
    delete process.env.GATEWAY_SECRET;
    expect(gatewayHeaders()).toEqual({});
    process.env.GATEWAY_SECRET = SECRET;
    expect(gatewayHeaders()).toEqual({ "x-gateway-secret": SECRET });
  });
});
