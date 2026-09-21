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
//
// ACME_ADAPTER=none serves head with no adapter at all, which is how a
// provider behind the standalone proxy runs: the proxy translates, and doing
// it here as well would translate every request twice.
const adapter = process.env["ACME_ADAPTER"] !== "none";
const { fetch: handler, build } = createAcmeApp({
  build: raw,
  ...(raw === "head" && adapter ? { program: ACME_PROGRAM } : {}),
});

// `fetch` rather than `app.fetch`: path rewriting has to happen outside the
// router, so an old URL reaches the canonical handler at all.
// Loopback unless told otherwise. A container fronting this build reaches it
// through the host's gateway, which loopback does not answer on.
const hostname = process.env["HOST"] ?? "127.0.0.1";
serve({ fetch: handler, port, hostname }, (info) => {
  console.log(`acme ${build} listening on http://${hostname}:${info.port}`);
});
