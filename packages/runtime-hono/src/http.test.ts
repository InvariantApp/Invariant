/**
 * Bodies that are not plain JSON, on an operation that has compiled work.
 *
 * The binding used to read every such body in full and hand it to
 * `JSON.parse`: a CSV export became a 502, a multipart upload a 400, an event
 * stream was held until it ended, and a compressed response was parsed as
 * compressed bytes. Each is either passed through untouched or, where it is
 * JSON underneath, translated like any other body.
 */
import { createRuntime } from "@invariant/runtime";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { adapt, wrapFetch } from "./index.ts";

const OLD = "2026-01-01";

const PROGRAM = {
  irVersion: 2,
  api: "payments",
  currentLabel: "2026-09-20",
  current: "sha256:head",
  contracts: {
    [OLD]: {
      label: OLD,
      routes: [],
      sites: {
        "post /v1/things": {
          request: [{ k: "move", from: "/amount", to: "/amount_cents", c: "chg_a" }],
          response: {
            "2xx": [{ k: "move", from: "/amount_cents", to: "/amount", c: "chg_a" }],
          },
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

function service(handler: (c: import("hono").Context) => Response | Promise<Response>) {
  const inv = createRuntime({
    program: PROGRAM,
    identity: [
      { kind: "header" as const, name: "payments-version" },
      { kind: "default" as const, label: "2026-09-20" },
    ],
    maxBodyBytes: 1024,
  });
  const app = new Hono();
  app.use("/v1/*", adapt({ runtime: inv }));
  app.post("/v1/things", handler);
  return wrapFetch((request) => app.fetch(request), { runtime: inv });
}

const post = (
  body: string | Uint8Array,
  type: string,
  extra: Record<string, string> = {},
) =>
  new Request("https://api.example.com/v1/things", {
    method: "POST",
    headers: { "payments-version": OLD, "content-type": type, ...extra },
    body,
  });

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("bodies that are not plain JSON", () => {
  it("passes a CSV response through untouched", async () => {
    const response = await service((c) =>
      c.body("amount_cents\n100\n", 200, { "content-type": "text/csv" }),
    )(post("{}", "application/json"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("amount_cents\n100\n");
  });

  it("passes a multipart request through to the handler as it came", async () => {
    const form = new FormData();
    form.set("amount", "12");
    let seen = "";
    const response = await service(async (c) => {
      seen = String((await c.req.formData()).get("amount"));
      return c.json({ ok: true });
    })(
      new Request("https://api.example.com/v1/things", {
        method: "POST",
        headers: { "payments-version": OLD },
        body: form,
      }),
    );
    expect(response.status).toBe(200);
    expect(seen).toBe("12");
  });

  it("streams an event stream without waiting for it to end", async () => {
    let close: () => void = () => {};
    const response = await service(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"amount_cents":1}\n\n'));
          close = () => controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    })(post("{}", "application/json"));

    // The first event is readable while the stream is still open. A binding
    // that buffered would never resolve this read.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("amount_cents");
    close();
  });

  it("translates a gzip response and stops declaring the encoding", async () => {
    const compressed = await gzip('{"amount_cents":250}');
    const response = await service(
      () =>
        new Response(compressed, {
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
        }),
    )(post("{}", "application/json"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.json()).toEqual({ amount: 250 });
  });

  it("translates a gzip request before the handler reads it", async () => {
    let seen: unknown;
    await service(async (c) => {
      seen = await c.req.json();
      return c.json({});
    })(
      post(await gzip('{"amount":7}'), "application/json", {
        "content-encoding": "gzip",
      }),
    );
    expect(seen).toEqual({ amount_cents: 7 });
  });

  it("refuses an encoding it cannot decode rather than parsing the bytes", async () => {
    const response = await service(() => new Response("{}"))(
      post("xx", "application/json", { "content-encoding": "compress" }),
    );
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invariant_encoding_unsupported");
  });

  it("counts decoded bytes, so a small compressed body cannot expand past the limit", async () => {
    const bomb = await gzip(JSON.stringify({ amount: 1, pad: "x".repeat(100_000) }));
    expect(bomb.byteLength).toBeLessThan(1024);
    const response = await service(() => new Response("{}"))(
      post(bomb, "application/json", { "content-encoding": "gzip" }),
    );
    expect(response.status).toBe(413);
  });

  it("never lets the handler's length describe the translated body", async () => {
    const body = '{"amount_cents":250}';
    const response = await service(
      () =>
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            "content-md5": "stale",
          },
        }),
    )(post("{}", "application/json"));
    const text = await response.text();
    expect(text).toBe('{"amount":250}');
    expect(response.headers.get("content-length")).toBe(String(text.length));
    expect(response.headers.get("content-md5")).toBeNull();
  });
});
