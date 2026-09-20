import { Hono, type MiddlewareHandler } from "hono";
import { acmeAuth } from "./auth.ts";
import { buildHead } from "./builds/head.ts";
import { buildV1 } from "./builds/v1.ts";
import { buildV2 } from "./builds/v2.ts";
import { AcmeStore } from "./store.ts";

export { API_KEYS, SIGNING_SECRET, sign } from "./auth.ts";
export { AcmeStore } from "./store.ts";

/**
 * Which historical build of the provider to run. `head` is the canonical
 * current API; the dated builds are what the provider's code looked like when
 * that contract was current, and exist so the differential verifier has a real
 * baseline to compare against.
 */
export type AcmeBuild = "2026-01-15" | "2026-03-01" | "head";

export const ACME_BUILDS: readonly AcmeBuild[] = ["2026-01-15", "2026-03-01", "head"];

export function isAcmeBuild(value: string): value is AcmeBuild {
  return (ACME_BUILDS as readonly string[]).includes(value);
}

export interface CreateAcmeAppOptions {
  build?: AcmeBuild;
  store?: AcmeStore;
  /** Runs before routing, so it may rewrite the request path. */
  preRouting?: MiddlewareHandler;
  /** Runs after authentication, so it may rewrite an authenticated body. */
  postAuth?: MiddlewareHandler;
}

export function createAcmeApp(options: CreateAcmeAppOptions = {}): {
  app: Hono;
  store: AcmeStore;
  build: AcmeBuild;
} {
  const build = options.build ?? "head";
  const store = options.store ?? new AcmeStore();

  const app = new Hono();
  app.get("/__health", (c) => c.json({ ok: true, build }));

  if (options.preRouting) app.use("*", options.preRouting);
  app.use("/v1/*", acmeAuth);
  if (options.postAuth) app.use("/v1/*", options.postAuth);

  const routes =
    build === "head"
      ? buildHead(store)
      : build === "2026-03-01"
        ? buildV2(store)
        : buildV1(store);
  app.route("/", routes);

  return { app, store, build };
}
