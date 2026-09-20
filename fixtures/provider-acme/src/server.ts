import { serve } from "@hono/node-server";
import { createAcmeApp, isAcmeBuild } from "./index.ts";
import { ACME_PROGRAM } from "./program.ts";

const raw = process.env["ACME_BUILD"] ?? "head";
if (!isAcmeBuild(raw)) {
  console.error(`ACME_BUILD must be one of 2026-01-15, 2026-03-01, head (got ${raw})`);
  process.exit(2);
}

const port = Number(process.env["PORT"] ?? 8787);

/**
 * The compiled program ships with the current build and no other.
 *
 * A historical build already speaks its own contract; handing it an adapter as
 * well would transform requests that were never in the old shape. Only the
 * build that serves the canonical API needs to translate anything, which is
 * also why reverting a deploy reverts the adapter with it.
 */
const { fetch: handler, build } = createAcmeApp({
  build: raw,
  ...(raw === "head" ? { program: ACME_PROGRAM } : {}),
});

// `fetch` rather than `app.fetch`: path rewriting has to happen outside the
// router, so an old URL reaches the canonical handler at all.
serve({ fetch: handler, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`acme ${build} listening on http://127.0.0.1:${info.port}`);
});
