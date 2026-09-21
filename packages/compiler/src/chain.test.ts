/**
 * The compiled program is what actually ships, so these tests read it back in
 * full rather than spot-checking it. Consumer A sits two contracts behind, so
 * its program is the real test of chaining: two steps of Changes collapsed into
 * one pass, requests replayed forward and responses undone in reverse.
 */
import { loadContract, loadPendingChanges, loadReleaseStep } from "@invariant/contract";
import { type CompiledProgram, parseCompiledProgram } from "@invariant/ir";
import { beforeAll, describe, expect, it } from "vitest";
import { type ContractStep, chainProgram, expandChains } from "./chain.ts";

const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;

let steps: ContractStep[];
let program: ReturnType<typeof chainProgram>;
/** Each contract's work written out in full, as it runs. */
let written: CompiledProgram;

beforeAll(async () => {
  const [v1, v2, head] = await Promise.all([
    loadContract(`${FIXTURE}openapi/2026-01-15.json`, "2026-01-15"),
    loadContract(`${FIXTURE}openapi/2026-03-01.json`, "2026-03-01"),
    loadContract(`${FIXTURE}openapi/head.json`, "2026-09-20"),
  ]);
  const released = await loadReleaseStep(`${FIXTURE}invariant`, "2026-03-01");
  const pending = await loadPendingChanges(`${FIXTURE}invariant`);

  steps = [
    {
      label: "2026-03-01",
      parent: "2026-01-15",
      from: v1.document,
      to: v2.document,
      changes: released.changes,
    },
    {
      label: "2026-09-20",
      parent: "2026-03-01",
      from: v2.document,
      to: head.document,
      changes: pending,
    },
  ];
  program = chainProgram("acme-payments", "2026-09-20", head.digest, steps);
  written = expandChains(program.program);
});

describe("chained program", () => {
  it("compiles without issues and validates against the IR schema", () => {
    expect(program.issues).toEqual([]);
    expect(() => parseCompiledProgram(program.program)).not.toThrow();
  });

  it("serves every historical contract, each straight through to current", () => {
    expect(Object.keys(program.program.contracts)).toEqual(["2026-01-15", "2026-03-01"]);
    expect(program.program.currentLabel).toBe("2026-09-20");
  });

  it("rewrites the oldest contract's paths straight to where they live now", () => {
    const oldest = program.program.contracts["2026-01-15"];
    expect(oldest?.routes).toEqual([
      {
        from: { method: "get", path: "/v1/charges" },
        to: { method: "get", path: "/v1/payments" },
        c: "chg_charges_became_payments",
      },
      {
        from: { method: "get", path: "/v1/charges/{id}" },
        to: { method: "get", path: "/v1/payments/{id}" },
        c: "chg_charges_became_payments",
      },
      {
        from: { method: "post", path: "/v1/charges" },
        to: { method: "post", path: "/v1/payments" },
        c: "chg_charges_became_payments",
      },
    ]);
  });

  it("collapses two contract steps into one forward pass on the request", () => {
    const create = written.contracts["2026-01-15"]?.sites["post /v1/payments"];
    expect(create?.request).toEqual([
      // Step one: the flat token moves under payment_method.
      {
        k: "move",
        from: "/source",
        to: "/payment_method/token",
        c: "chg_source_became_payment_method",
      },
      // Step two. These two Changes touch different fields, which the compiler
      // checks, so their relative order carries no meaning.
      {
        k: "set",
        path: "/capture_method",
        value: "automatic",
        ifAbsent: true,
        c: "chg_capture_method",
      },
      { k: "move", from: "/amount", to: "/amount_cents", c: "chg_money_in_minor_units" },
      { k: "scale", path: "/amount_cents", exp: 2, c: "chg_money_in_minor_units" },
    ]);
  });

  it("undoes both steps in reverse on the response", () => {
    const create = written.contracts["2026-01-15"]?.sites["post /v1/payments"];
    expect(create?.response?.["201"]).toEqual([
      // Latest step first, its Changes in reverse, each Change's ops reversed.
      {
        k: "enum",
        path: "/status",
        map: { paid: "succeeded", failed: "failed", processing: "pending" },
        c: "chg_payment_status_vocabulary",
      },
      { k: "scale", path: "/amount_cents", exp: -2, c: "chg_money_in_minor_units" },
      { k: "move", from: "/amount_cents", to: "/amount", c: "chg_money_in_minor_units" },
      { k: "del", path: "/capture_method", c: "chg_capture_method" },
      // Then the earlier step.
      {
        k: "move",
        from: "/payment_method/token",
        to: "/source",
        c: "chg_source_became_payment_method",
      },
      {
        k: "enum",
        path: "/object",
        map: { payment: "charge" },
        c: "chg_charges_became_payments",
      },
    ]);
  });

  it("reaches inside a list envelope using the wildcard segment", () => {
    const list = written.contracts["2026-01-15"]?.sites["get /v1/payments"];
    const instrs = list?.response?.["200"] ?? [];
    expect(
      instrs.every((instr) =>
        ("path" in instr ? instr.path : "from" in instr ? instr.from : "").startsWith(
          "/data/*",
        ),
      ),
    ).toBe(true);
    expect(instrs).toContainEqual({
      k: "scale",
      path: "/data/*/amount_cents",
      exp: -2,
      c: "chg_money_in_minor_units",
    });
  });

  it("gives the newer contract only the work it actually needs", () => {
    const recent = written.contracts["2026-03-01"];
    expect(recent?.routes).toEqual([]);
    const create = recent?.sites["post /v1/payments"];
    expect(create?.request).toEqual([
      {
        k: "set",
        path: "/capture_method",
        value: "automatic",
        ifAbsent: true,
        c: "chg_capture_method",
      },
      { k: "move", from: "/amount", to: "/amount_cents", c: "chg_money_in_minor_units" },
      { k: "scale", path: "/amount_cents", exp: 2, c: "chg_money_in_minor_units" },
    ]);
  });

  it("maps refunds, which changed in both steps, on both directions", () => {
    const refunds = written.contracts["2026-01-15"]?.sites["post /v1/refunds"];
    expect(refunds?.request).toEqual([
      { k: "move", from: "/charge", to: "/payment", c: "chg_refund_targets_payment" },
      { k: "move", from: "/amount", to: "/amount_cents", c: "chg_money_in_minor_units" },
      { k: "scale", path: "/amount_cents", exp: 2, c: "chg_money_in_minor_units" },
    ]);
    expect(refunds?.response?.["201"]).toEqual([
      { k: "scale", path: "/amount_cents", exp: -2, c: "chg_money_in_minor_units" },
      { k: "move", from: "/amount_cents", to: "/amount", c: "chg_money_in_minor_units" },
      { k: "move", from: "/payment", to: "/charge", c: "chg_refund_targets_payment" },
    ]);
  });

  it("holds each step's work once, the older contract calling the newer one's", () => {
    // Written out per contract, a program grows with the square of its
    // history, since every contract repeats every later step (launch gate L18).
    const site = (label: string) =>
      program.program.contracts[label]?.sites["post /v1/payments"]?.request ?? [];
    const [recent] = site("2026-03-01");
    const oldest = site("2026-01-15").at(-1);
    expect(recent?.k).toBe("call");
    expect(oldest).toEqual(recent);
    const name = recent?.k === "call" ? recent.block : "";
    expect(program.program.blocks?.[name]).toEqual(
      written.contracts["2026-03-01"]?.sites["post /v1/payments"]?.request,
    );
  });

  it("leaves untouched operations out of the program entirely", () => {
    // Nothing should be buffered or parsed for a site with no work to do.
    const oldest = program.program.contracts["2026-01-15"];
    for (const [key, site] of Object.entries(oldest?.sites ?? {})) {
      expect(
        (site.request?.length ?? 0) + Object.keys(site.response ?? {}).length,
        `${key} was compiled with no instructions`,
      ).toBeGreaterThan(0);
    }
  });
});
