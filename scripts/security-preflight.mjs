#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIN_SECRET_LENGTH = 32;
const DEV_DEFAULTS = new Set([
  "secret",
  "changeme",
  "change-me",
  "gateway-secret",
  "dev-gateway-secret-change-me",
  "hotelsync-dev-gateway-secret",
  "hotelsync-gateway-secret-dev",
]);

const HARDENED = {
  "api-gateway": "src/security.ts",
  "property-service": "src/lib/security.ts",
  "rate-availability-service": "src/lib/security.ts",
  "booking-service": "src/lib/security.ts",
  "front-desk-service": "src/lib/security.ts",
  "user-service": "src/lib/security.ts",
};

const root = process.cwd();
const errors = [];
const warnings = [];

function parseEnv(path) {
  const env = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalIndex = line.indexOf("=");
    if (equalIndex === -1) continue;
    const key = line.slice(0, equalIndex).trim();
    const value = line.slice(equalIndex + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = value;
  }
  return env;
}

function detectServices() {
  const servicesDir = join(root, "services");
  if (existsSync(servicesDir)) {
    return readdirSync(servicesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, dir: join(servicesDir, entry.name) }))
      .filter((service) => existsSync(join(service.dir, "package.json")));
  }

  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const name = String(pkg.name ?? "").replace(/^@[^/]+\//, "");
  return [{ name, dir: root }];
}

function checkSecret(label, value) {
  if (value.length < MIN_SECRET_LENGTH) {
    errors.push(`${label} es demasiado corto (${value.length} < ${MIN_SECRET_LENGTH})`);
  }
  if (DEV_DEFAULTS.has(value.toLowerCase())) {
    errors.push(`${label} usa un valor por defecto de desarrollo`);
  }
}

const services = detectServices();

if (services.length === 0) {
  errors.push("no se detectaron servicios (ni services/* ni package.json de servicio)");
}

for (const service of services) {
  const envPath = join(service.dir, ".env");
  const hardenedFile = HARDENED[service.name];

  if (hardenedFile && !existsSync(join(service.dir, hardenedFile))) {
    errors.push(`${service.name}: falta ${hardenedFile} (hardening no aplicado)`);
  }

  const indexFile = join(service.dir, "src", "index.ts");
  const appFile = join(service.dir, "src", "app.ts");
  const wiringFiles = [indexFile, appFile].filter((file) => existsSync(file));
  if (hardenedFile && wiringFiles.length > 0) {
    const source = wiringFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    if (!source.includes("metricsGuard")) {
      errors.push(`${service.name}: el arranque no protege /metrics con metricsGuard`);
    }
    if (!source.includes("securityHeaders")) {
      errors.push(`${service.name}: el arranque no aplica securityHeaders`);
    }
  }

  if (!existsSync(envPath)) {
    warnings.push(`${service.name}: sin .env local (no se pueden validar secretos)`);
    continue;
  }

  const env = parseEnv(envPath);
  const gatewaySecret = env.GATEWAY_SECRET;
  const sharedSecret = env.GATEWAY_SHARED_SECRET;
  const previous = env.GATEWAY_SECRET_PREVIOUS;

  if (service.name === "api-gateway" && sharedSecret) {
    checkSecret(`${service.name}/GATEWAY_SHARED_SECRET`, sharedSecret);
  } else if (service.name !== "api-gateway" && gatewaySecret) {
    checkSecret(`${service.name}/GATEWAY_SECRET`, gatewaySecret);
  }

  if (env.GATEWAY_MODE === "enforce" && service.name !== "api-gateway" && !gatewaySecret) {
    errors.push(`${service.name}: GATEWAY_MODE=enforce exige GATEWAY_SECRET`);
  }

  if (gatewaySecret && previous && gatewaySecret === previous) {
    warnings.push(`${service.name}: GATEWAY_SECRET_PREVIOUS igual al actual (rotación inútil)`);
  }

  if (env.METRICS_TOKEN && env.METRICS_TOKEN.length < 24) {
    warnings.push(`${service.name}: METRICS_TOKEN corto (< 24 caracteres)`);
  }
}

for (const warning of warnings) console.warn(`warn  ${warning}`);
for (const error of errors) console.error(`error ${error}`);

if (errors.length > 0) {
  console.error(`\nsecurity-preflight: ${errors.length} error(es), ${warnings.length} aviso(s)`);
  process.exit(1);
}

console.log(`security-preflight: OK (${services.length} servicio(s), ${warnings.length} aviso(s))`);
