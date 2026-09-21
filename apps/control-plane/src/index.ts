/**
 * The registry.
 *
 * It holds contracts and signed bundles, takes counters from running adapters,
 * and answers what production is still using. It is deliberately not in
 * anyone's request path: a provider whose service cannot reach this keeps
 * serving every old contract exactly as before, because the compiled program
 * ships inside their build.
 *
 * Two rules shape all of it. A token decides which tenant a request is for, and
 * nothing a caller sends can override that. And a bundle is only accepted if it
 * verifies against a key the provider registered in advance, so the registry
 * distributes what a provider signed rather than what somebody uploaded.
 */
import { createHash } from "node:crypto";
import { type EvolutionBundle, openBundle } from "@invariant/bundle";
import { isJsonObject } from "@invariant/ir";
import { Hono } from "hono";
import type { Store, UsageRow } from "./store.ts";

export { Store } from "./store.ts";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface Vars {
  api: string;
  publisherKeys: string[];
}

function error(message: string, code: string) {
  return { error: { code, message } };
}

export function createControlPlane(store: Store): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();

  app.get("/health", (c) => c.json({ ok: true }));

  /**
   * Every route below this needs a token, and the token decides the tenant.
   *
   * The API id is never read from a path, a query or a body. A token valid for
   * one provider naming another provider's API is the whole class of bug this
   * shape rules out rather than defends against.
   */
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match) {
      return c.json(error("This endpoint needs a bearer token.", "unauthenticated"), 401);
    }

    const api = await store.apiForToken(hashToken(match[1] as string));
    if (!api) {
      return c.json(error("That token is not one we issued.", "unauthenticated"), 401);
    }

    c.set("api", api.id);
    c.set("publisherKeys", api.publisherKeys);
    await next();
    return undefined;
  });

  /**
   * Publishing a bundle.
   *
   * The registry verifies the signature itself rather than trusting the
   * uploader, and against keys the provider registered before this request
   * existed. A bundle that arrives signed by a key nobody registered is
   * refused, which is what stops this from being a place to put anything.
   */
  app.post("/v1/bundles", async (c) => {
    const envelope: unknown = await c.req.json().catch(() => undefined);
    if (!isJsonObject(envelope)) {
      return c.json(error("Send a DSSE envelope as JSON.", "malformed"), 400);
    }

    const keys = c.get("publisherKeys");
    if (keys.length === 0) {
      return c.json(
        error(
          "No publisher key is registered for this API, so nothing can be verified.",
          "no_publisher_key",
        ),
        409,
      );
    }

    let bundle: EvolutionBundle;
    let digest: string;
    let keyid: string;
    try {
      ({ bundle, digest, keyid } = openBundle(envelope as never, keys));
    } catch (failure) {
      return c.json(
        error(
          failure instanceof Error ? failure.message : "This bundle could not be opened.",
          "rejected",
        ),
        400,
      );
    }

    // The signature proves who sent it. This proves it is about the API the
    // token is for, which the signature does not.
    const api = c.get("api");
    if (bundle.api !== api) {
      return c.json(
        error(
          `This bundle is for ${bundle.api}, and this token is for ${api}.`,
          "wrong_api",
        ),
        403,
      );
    }

    const { created } = await store.putBundle({
      digest,
      api,
      fromLabel: bundle.from.label,
      toLabel: bundle.to.label,
      payload: JSON.stringify(envelope),
      keyid,
      publishedAt: Math.floor(Date.now() / 1000),
    });

    return c.json({ digest, created, api, to: bundle.to.label }, created ? 201 : 200);
  });

  app.get("/v1/bundles", async (c) =>
    c.json({ bundles: await store.listBundles(c.get("api")) }),
  );

  app.get("/v1/bundles/:digest", async (c) => {
    const found = await store.getBundle(c.get("api"), c.req.param("digest"));
    if (!found) return c.json(error("No such bundle.", "not_found"), 404);
    return c.json(JSON.parse(found.payload) as unknown);
  });

  /**
   * Counters from a running adapter.
   *
   * What arrives is a hashed consumer key, a contract label, a change id and a
   * count. No bodies and no field values, so this endpoint cannot be made to
   * carry customer data however it is called.
   */
  app.post("/v1/ingest/usage", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    if (!isJsonObject(body) || !Array.isArray(body["records"])) {
      return c.json(error("Send { records: [...] }.", "malformed"), 400);
    }

    const api = c.get("api");
    const rows: UsageRow[] = [];
    for (const entry of body["records"]) {
      if (!isJsonObject(entry)) continue;
      const { consumer, contract, changeId, count, lastSeen } = entry;
      if (
        typeof consumer !== "string" ||
        typeof contract !== "string" ||
        typeof changeId !== "string" ||
        typeof count !== "number" ||
        typeof lastSeen !== "number"
      ) {
        continue;
      }
      // The api comes from the token, not from the row, so a runtime cannot
      // report counters against somebody else's contract.
      rows.push({ api, consumer, contract, changeId, count, lastSeen });
    }

    await store.ingestUsage(rows);
    return c.json({
      accepted: rows.length,
      ignored: body["records"].length - rows.length,
    });
  });

  app.get("/v1/impact", async (c) => {
    const rows = await store.impact(c.get("api"));
    return c.json({ api: c.get("api"), usage: rows });
  });

  /**
   * The flags a runtime polls.
   *
   * Served with an ETag so the common answer is a 304 and costs nothing. A
   * runtime that cannot reach this keeps its last good answer, which is why
   * this being down is not an incident.
   */
  app.get("/v1/flags", async (c) => {
    const { document, updatedAt } = await store.getFlags(c.get("api"));
    const etag = `"${createHash("sha256").update(document).digest("hex").slice(0, 16)}"`;

    if (c.req.header("if-none-match") === etag) return c.body(null, 304);

    c.header("etag", etag);
    c.header("cache-control", "no-cache");
    return c.json({ flags: JSON.parse(document) as unknown, updatedAt });
  });

  app.put("/v1/flags", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    if (!isJsonObject(body)) {
      return c.json(error("Send the flags as a JSON object.", "malformed"), 400);
    }
    await store.setFlags(
      c.get("api"),
      JSON.stringify(body),
      Math.floor(Date.now() / 1000),
    );
    return c.json({ ok: true });
  });

  return app;
}
