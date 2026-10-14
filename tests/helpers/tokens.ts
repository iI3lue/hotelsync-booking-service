import { createHmac } from "node:crypto";

/**
 * Firma tokens HS256 con el mismo contrato que user-service
 * (iss `hotelsync`, aud `hotelsync-api`, secreto compartido con
 * fallback de test). Helper local para que los tests no importen
 * codigo de otro microservicio: asi el split standalone puede
 * correrlos sin el monorepo.
 */
export function signAccessToken(input: {
  sub: string;
  email: string;
  email_verified?: boolean;
  role: string;
  hotel_id: string | null;
}): string {
  const secret = process.env.AUTH_JWT_SECRET;
  const key =
    secret && secret.length >= 32
      ? secret
      : "test-secret-for-unit-tests-only-32b!";
  const base64url = (v: string) => Buffer.from(v, "utf8").toString("base64url");
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      sub: input.sub,
      email: input.email,
      email_verified: input.email_verified ?? false,
      role: input.role,
      hotel_id: input.hotel_id,
      scope: input.hotel_id ? "hotel" : "global",
      iss: "hotelsync",
      aud: "hotelsync-api",
      iat: now,
      exp: now + 15 * 60,
    })
  );
  const signature = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}
