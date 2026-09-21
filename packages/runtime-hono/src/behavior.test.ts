/**
 * The escape hatch as a provider actually reaches it.
 *
 * `InvariantRuntime.before` is tested on its own elsewhere. What matters here
 * is the wiring: a real handler, on a real route, branching on a real request,
 * getting the right answer for a caller who declared an old contract and for
 * one who declared nothing.
 *
 * The change being branched on is a deliberate choice. Splitting `name` into
 * `first_name` and `last_name` is not expressible as any op in the catalog and
 * never will be, because a response has to be put back together for the old
 * caller and there is no general way to take a full name apart. This is what a
 * provider does instead, and it has to work.
 */
import { createRuntime } from "@invariant/runtime";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { adapt, before, contractOf, wrapFetch } from "./index.ts";

const PROGRAM = {
  irVersion: 2,
  api: "contacts",
  currentLabel: "2026-09-20",
  current: "sha256:head",
  contracts: {
    "2026-01-01": {
      label: "2026-01-01",
      routes: [],
      sites: {},
      behaviors: ["chg_contact_name_split"],
    },
  },
};

const IDENTITY = [
  { kind: "header" as const, name: "contacts-version" },
  { kind: "default" as const, label: "2026-09-20" },
];

interface Contact {
  first_name: string;
  last_name: string;
}

function service(onUsage?: (event: never) => void) {
  const inv = createRuntime({
    program: PROGRAM,
    identity: IDENTITY,
    ...(onUsage ? { onUsage: onUsage as () => void } : {}),
  });
  const app = new Hono();

  app.use("/v1/*", adapt({ runtime: inv }));

  app.post("/v1/contacts", async (c) => {
    const body = (await c.req.json()) as Record<string, string>;

    // The provider's own code, written once, branching on contract age. There
    // is no adapter for this and there never will be.
    const contact: Contact = before(inv, c, "chg_contact_name_split")
      ? splitName(body["name"] ?? "")
      : { first_name: body["first_name"] ?? "", last_name: body["last_name"] ?? "" };

    const stored = { id: "ct_1", ...contact };
    return c.json(
      before(inv, c, "chg_contact_name_split")
        ? { id: stored.id, name: `${stored.first_name} ${stored.last_name}`.trim() }
        : stored,
      201,
    );
  });

  return { app: wrapFetch((request) => app.fetch(request), { runtime: inv }), inv };
}

function splitName(full: string): Contact {
  const at = full.trim().lastIndexOf(" ");
  return at === -1
    ? { first_name: full.trim(), last_name: "" }
    : { first_name: full.slice(0, at), last_name: full.slice(at + 1) };
}

function post(body: unknown, version?: string): Request {
  return new Request("https://api.example.com/v1/contacts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(version ? { "contacts-version": version } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("a change no op can express", () => {
  it("serves the old caller the shape their contract declares", async () => {
    const { app } = service();
    const response = await app(post({ name: "Ada Lovelace" }, "2026-01-01"));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "ct_1", name: "Ada Lovelace" });
  });

  it("serves a caller who declared nothing the current shape", async () => {
    const { app } = service();
    const response = await app(post({ first_name: "Ada", last_name: "Lovelace" }));

    expect(await response.json()).toEqual({
      id: "ct_1",
      first_name: "Ada",
      last_name: "Lovelace",
    });
  });

  it("counts the branch so it can eventually be deleted", async () => {
    const onUsage = vi.fn();
    const { app } = service(onUsage);
    await app(post({ name: "Ada Lovelace" }, "2026-01-01"));

    // Twice, because the handler asks on the way in and on the way out. What
    // matters for retirement is that it is not zero.
    expect(onUsage).toHaveBeenCalled();
    const event = onUsage.mock.calls[0]?.[0] as { contract: string; operation: string };
    expect(event.contract).toBe("2026-01-01");
    expect(event.operation).toBe("post /v1/contacts");
  });

  /**
   * A caller can choose their own contract label, so a behaviour branch is
   * caller-controlled input. It may decide what shape they are served. It may
   * never decide what they are allowed to do.
   */
  it("cannot be reached on a route the adapter does not cover", async () => {
    const inv = createRuntime({ program: PROGRAM, identity: IDENTITY });
    const app = new Hono();
    app.use("/v1/*", adapt({ runtime: inv }));
    app.get("/internal/whoami", (c) => c.text(contractOf(c)));
    // Answered here rather than by Hono's default handler, which would print
    // the error into the test log as though something had gone wrong.
    app.onError((error, c) => c.text(error.message, 500));

    const response = await app.fetch(
      new Request("https://api.example.com/internal/whoami"),
    );

    // Loud, not a quiet assumption that the caller is current.
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Mount adapt() on this route");
  });
});
