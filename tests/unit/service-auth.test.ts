import { isTrustedService } from "../../src/lib/auth.js";

function reqWith(headers: Record<string, string>) {
  return { headers } as any;
}

describe("isTrustedService (x-loyalty-key)", () => {
  const OLD = process.env.LOYALTY_SERVICE_KEY;
  const KEY = "test-loyalty-key-32-chars-min-ok!!";

  beforeEach(() => {
    process.env.LOYALTY_SERVICE_KEY = KEY;
  });

  afterAll(() => {
    if (OLD === undefined) delete process.env.LOYALTY_SERVICE_KEY;
    else process.env.LOYALTY_SERVICE_KEY = OLD;
  });

  it("confía en loyalty-service con la clave correcta", () => {
    expect(
      isTrustedService(reqWith({ "x-loyalty-key": KEY }))
    ).toBe(true);
  });

  it("rechaza clave incorrecta o ausente", () => {
    expect(isTrustedService(reqWith({ "x-loyalty-key": "otra" }))).toBe(false);
    expect(isTrustedService(reqWith({}))).toBe(false);
  });

  it("rechaza si el secreto no está configurado", () => {
    delete process.env.LOYALTY_SERVICE_KEY;
    expect(isTrustedService(reqWith({ "x-loyalty-key": KEY }))).toBe(false);
  });
});
