import { AppError } from "../middleware/error-handler.js";

const RATE_SERVICE_URL =
  process.env.RATE_SERVICE_URL || "http://localhost:3002/v1";

const SERVICE_API_KEY = process.env.SERVICE_API_KEY || "";

export interface RateRangeInput {
  room_type_id: string;
  check_in: string;
  check_out: string;
  count?: number;
  idempotency_key?: string;
}

/**
 * Cliente HTTP hacia Rate & Availability Service (comunicación síncrona REST).
 * Materializa RN-1 (confirmar decrementa inventario) y RN-2 (cancelar libera
 * inventario): el R&A valida stock con bloqueo optimista sobre `inventory`.
 */
async function ratePost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RATE_SERVICE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SERVICE_API_KEY ? { "x-service-key": SERVICE_API_KEY } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AppError(
      502,
      "Rate & Availability Service unavailable",
      "Bad Gateway"
    );
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    const message =
      data.message || data.error || `Rate & Availability Service error: ${res.status}`;
    if (res.status === 409) {
      throw new AppError(409, message, "Conflict");
    }
    throw new AppError(502, message, "Bad Gateway");
  }

  return (await res.json()) as T;
}

export async function reserveInventory(input: RateRangeInput): Promise<unknown> {
  return ratePost("/availability/reserve", input);
}

export async function releaseInventory(input: RateRangeInput): Promise<unknown> {
  return ratePost("/availability/release", input);
}