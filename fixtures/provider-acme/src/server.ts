import { serve } from "@hono/node-server";
import { createAcmeApp, isAcmeBuild } from "./index.ts";

const raw = process.env["ACME_BUILD"] ?? "head";
if (!isAcmeBuild(raw)) {
  console.error(`ACME_BUILD must be one of 2026-01-15, 2026-03-01, head (got ${raw})`);
  process.exit(2);
}

const port = Number(process.env["PORT"] ?? 8787);
const { app, build } = createAcmeApp({ build: raw });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`acme ${build} listening on http://127.0.0.1:${info.port}`);
});
