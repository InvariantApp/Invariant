import type { Context } from "hono";

export interface ApiErrorBody {
  error: { type: string; message: string; param?: string };
}

export function invalidRequest(c: Context, message: string, param?: string): Response {
  const body: ApiErrorBody = {
    error: {
      type: "invalid_request_error",
      message,
      ...(param === undefined ? {} : { param }),
    },
  };
  return c.json(body, 400);
}

export function notFound(c: Context, message: string): Response {
  const body: ApiErrorBody = { error: { type: "not_found_error", message } };
  return c.json(body, 404);
}

/** Every currency this fixture supports uses two minor-unit digits. */
export const MINOR_UNIT_EXPONENT = 2;

export const SUPPORTED_CURRENCIES = ["usd", "eur", "gbp"] as const;

/**
 * Legacy major-unit conversion, written the way the original Acme code was.
 * Deliberately naive float arithmetic: the compatibility adapter uses exact
 * decimal-string math instead, and the differential test proves the two agree
 * on every scenario.
 */
export function toMinor(major: number): number {
  return Math.round(major * 100);
}

export function toMajor(minor: number): number {
  return minor / 100;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readLimit(raw: string | undefined): number {
  if (raw === undefined) return 10;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) return 10;
  return n;
}

export async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await c.req.json();
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
