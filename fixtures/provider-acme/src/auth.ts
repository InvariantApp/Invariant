import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import type { ApiErrorBody } from "./support.ts";

/**
 * API keys double as the account's pinned contract, the way a real provider
 * stores a default API version against the account.
 */
export const API_KEYS: Record<string, { account: string; pinned: string }> = {
  sk_test_alpha: { account: "acct_alpha", pinned: "2026-01-15" },
  sk_test_bravo: { account: "acct_bravo", pinned: "2026-03-01" },
  sk_test_charlie: { account: "acct_charlie", pinned: "2026-03-01" },
  sk_test_delta: { account: "acct_delta", pinned: "current" },
};

export const SIGNING_SECRET = "whsec_fixture_acme";

export interface AcmePrincipal {
  account: string;
  pinned: string;
  key: string;
}

declare module "hono" {
  interface ContextVariableMap {
    principal: AcmePrincipal;
  }
}

function unauthorized(c: Context, message: string): Response {
  const body: ApiErrorBody = { error: { type: "authentication_error", message } };
  return c.json(body, 401);
}

export function sign(rawBody: string): string {
  return createHmac("sha256", SIGNING_SECRET).update(rawBody).digest("hex");
}

/**
 * Bearer auth plus an optional body signature. The signature is computed over
 * the bytes the client actually sent, which is why any compatibility transform
 * of the body has to run strictly after this middleware.
 */
export async function acmeAuth(c: Context, next: Next): Promise<Response | undefined> {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) return unauthorized(c, "Missing bearer token.");

  const key = match[1] as string;
  const record = API_KEYS[key];
  if (!record) return unauthorized(c, "Invalid API key.");

  const provided = c.req.header("acme-signature");
  if (provided !== undefined) {
    const raw = await c.req.raw.clone().text();
    const expected = sign(raw);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return unauthorized(c, "Signature does not match the request body.");
    }
  }

  c.set("principal", { account: record.account, pinned: record.pinned, key });
  await next();
  return undefined;
}
