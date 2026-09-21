import {
  createRuntime,
  type InvariantRuntime,
  type UsageEvent,
} from "@invariant/runtime";
import { adapt, wrapFetch } from "@invariant/runtime-hono";
import { Hono } from "hono";
import { acmeAuth } from "./auth.ts";
import { buildHead } from "./builds/head.ts";
import { buildV1 } from "./builds/v1.ts";
import { buildV2 } from "./builds/v2.ts";
import { AcmeStore } from "./store.ts";

export { API_KEYS, SIGNING_SECRET, sign } from "./auth.ts";
export { ACME_PROGRAM } from "./program.ts";
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
  /**
   * The compiled program, as it would ship inside the provider's build. Only
   * meaningful alongside `head`, since the historical builds already speak
   * their own contract.
   */
  program?: unknown;
  onUsage?: (event: UsageEvent) => void;
  /** Where the fate of each adapted request and response is reported, for E9. */
  onOutcome?: Parameters<typeof createRuntime>[0]["onOutcome"];
  flags?: Parameters<typeof createRuntime>[0]["flags"];
}

export interface AcmeApp {
  app: Hono;
  /** Use this rather than `app.fetch`: stage one has to sit outside routing. */
  fetch: (request: Request) => Response | Promise<Response>;
  store: AcmeStore;
  build: AcmeBuild;
  runtime: InvariantRuntime | undefined;
}

export function createAcmeApp(options: CreateAcmeAppOptions = {}): AcmeApp {
  const build = options.build ?? "head";
  const store = options.store ?? new AcmeStore();

  const runtime = options.program
    ? createRuntime({
        // How a request names its contract comes with the program, from
        // invariant.yaml: the header first, then the account's pin.
        program: options.program,
        ...(options.onUsage ? { onUsage: options.onUsage } : {}),
        ...(options.onOutcome ? { onOutcome: options.onOutcome } : {}),
        ...(options.flags ? { flags: options.flags } : {}),
      })
    : undefined;

  const app = new Hono();
  app.get("/__health", (c) => c.json({ ok: true, build }));

  app.use("/v1/*", acmeAuth);
  if (runtime) {
    app.use(
      "/v1/*",
      adapt({
        runtime,
        pinnedContract: (c) => c.get("principal")?.pinned,
        consumerId: (c) => c.get("principal")?.account,
      }),
    );
  }

  const routes =
    build === "head"
      ? buildHead(store)
      : build === "2026-03-01"
        ? buildV2(store)
        : buildV1(store);
  app.route("/", routes);

  const fetch = runtime
    ? wrapFetch((request) => app.fetch(request), {
        runtime,
        skip: (path) => !path.startsWith("/v1/"),
      })
    : (request: Request) => app.fetch(request);

  return { app, fetch, store, build, runtime };
}
