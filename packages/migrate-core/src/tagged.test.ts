import type { Change } from "@invariant-app/ir";
import { describe, expect, it } from "vitest";
import { taggedObjectSites, type WireTags } from "./tagged.ts";

const removed = (schema: string, path: string): Change => ({
  irVersion: 1,
  id: `chg_gone_${schema}_${path.replaceAll("/", "_")}`,
  summary: `${path} is gone from ${schema}`,
  scopes: [{ schema: `#/components/schemas/${schema}` }],
  ops: [{ op: "remove", path, restore: null }],
});

const changes: Change[] = [
  removed("invoice", "/charge"),
  removed("invoice", "/status_transitions/finalized_at"),
  removed("line_item", "/plan"),
  {
    irVersion: 1,
    id: "chg_period",
    summary: "current_period_end moved into the items",
    scopes: [{ schema: "#/components/schemas/subscription" }],
    ops: [
      { op: "move", from: "/current_period_end", to: "/items/data/*/current_period_end" },
    ],
  },
];

const tags: WireTags = {
  property: "object",
  schemas: {
    invoice: "invoice",
    line_item: "line_item",
    subscription: "subscription",
    event: "event",
  },
  version: {
    schema: "event",
    property: "api_version",
    label: "2025-03-31.basil",
    sdk: "stripe-go v82",
  },
};

const lineOf = (text: string, needle: string) =>
  text.slice(0, text.indexOf(needle)).split("\n").length;

describe("taggedObjectSites", () => {
  it("finds the removed fields of a JSON fixture in a Go raw string, templates and all", () => {
    const text = [
      "package cli",
      "",
      "var invoicePaid = `{",
      '  "api_version": "2025-02-24.acacia",',
      '  "object": "event",',
      '  "data": {',
      '    "object": {',
      '      "object": "invoice",',
      '      "amount_due": {{ .Amount }},',
      '      "charge": "{{ .ChargeID }}",',
      '      "lines": {',
      '        "object": "list",',
      '        "data": [',
      '          { "object": "line_item", "plan": { "id": "{{ .PriceID }}", "object": "plan" }, "quantity": 1 }',
      "        ]",
      "      },",
      '      "status_transitions": { "finalized_at": 1727228884, "paid_at": null }',
      "    }",
      "  }",
      "}`",
    ].join("\n");
    const sites = taggedObjectSites("cli/webhook.go", text, changes, tags);
    expect(sites.map((site) => [site.line, site.snippet])).toEqual([
      [lineOf(text, "api_version"), '"api_version": "2025-02-24.acacia",'],
      [lineOf(text, '"charge"'), '"charge": "{{ .ChargeID }}",'],
      [lineOf(text, '"plan"'), expect.stringContaining('"plan"')],
      [lineOf(text, "finalized_at"), expect.stringContaining("finalized_at")],
    ]);
    // Each extent is the entry, key to the end of its value.
    const charge = sites[1];
    expect(text.slice(charge?.offset, charge?.end)).toBe('"charge": "{{ .ChargeID }}"');
    const plan = sites[2];
    expect(text.slice(plan?.offset, plan?.end)).toBe(
      '"plan": { "id": "{{ .PriceID }}", "object": "plan" }',
    );
    expect(sites[0]?.reason).toContain("2025-02-24.acacia");
    expect(sites[1]?.reason).toContain("`invoice`");
  });

  it("reads Python dictionaries and TypeScript object literals the same way", () => {
    const python = [
      "event = {",
      "    'object': 'subscription',",
      "    'id': 'sub_1',",
      "    'current_period_end': 123,  # it's a comment with an apostrophe",
      "}",
    ].join("\n");
    expect(
      taggedObjectSites("t.py", python, changes, tags).map((site) => site.snippet),
    ).toEqual(["'current_period_end': 123,  # it's a comment with an apostrophe"]);

    const typescript = [
      "const subscription = {",
      '  object: "subscription",',
      "  current_period_end: Date.now() / 1000,",
      "} as Stripe.Subscription;",
    ].join("\n");
    const sites = taggedObjectSites("t.ts", typescript, changes, tags);
    expect(sites.map((site) => site.snippet)).toEqual([
      "current_period_end: Date.now() / 1000,",
    ]);
    expect(sites[0]?.reason).toContain("moved to `items.data.*.current_period_end`");
  });

  it("leaves objects without the tag, with another tag, or already on the new version alone", () => {
    const text = [
      "{",
      '  "charge": "ch_1",',
      '  "nested": { "object": "charge", "charge": "x" },',
      '  "event": { "object": "event", "api_version": "2025-03-31.basil" },',
      '  "other": { object: someVariable, charge: 1 }',
      "}",
    ].join("\n");
    expect(taggedObjectSites("f.go", text, changes, tags)).toEqual([]);
  });

  it("is not thrown by brackets and quotes inside strings", () => {
    const text = [
      'x = """',
      "{",
      '  "object": "invoice",',
      '  "description": "a } and a { and a \\" in text",',
      '  "charge": null',
      "}",
      '"""',
    ].join("\n");
    expect(
      taggedObjectSites("f.py", text, changes, tags).map((site) => site.snippet),
    ).toEqual(['"charge": null']);
  });
});
