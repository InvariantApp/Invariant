import type { Change } from "@invariant-app/ir";
import { applyEdits, type WireOperation } from "@invariant-app/migrate-core";
import { describe, expect, it } from "vitest";
import type { EngineResult } from "./engine.ts";
import { parsePython } from "./syntax.ts";
import { operationFor, wireSites } from "./wire.ts";

const operations: WireOperation[] = [
  {
    id: "PostSubscriptionsSubscriptionExposedId",
    method: "post",
    path: "/v1/subscriptions/{subscription_exposed_id}",
    response: "subscription",
  },
  {
    id: "GetSubscriptionsSubscriptionExposedId",
    method: "get",
    path: "/v1/subscriptions/{subscription_exposed_id}",
    response: "subscription",
  },
  {
    id: "GetSubscriptionsSearch",
    method: "get",
    path: "/v1/subscriptions/search",
    response: "search_result",
  },
];
const servers = ["https://api.stripe.com/"];

describe("the operation a request reaches", () => {
  it("fits the method and the path, and prefers the path written out", () => {
    const id = (method: string, url: string) =>
      operationFor(method, url, servers, operations)?.id;
    expect(id("post", "https://api.stripe.com/v1/subscriptions/{}")).toBe(
      "PostSubscriptionsSubscriptionExposedId",
    );
    expect(id("get", "{}/v1/subscriptions/search?query=x")).toBe(
      "GetSubscriptionsSearch",
    );
    expect(id("get", "https://api.stripe.com/v1/subscriptions/sub_1")).toBe(
      "GetSubscriptionsSubscriptionExposedId",
    );
    expect(id("get", "https://example.com/v1/subscriptions/sub_1")).toBeUndefined();
    expect(id("delete", "https://api.stripe.com/v1/subscriptions/sub_1")).toBeUndefined();
  });
});

describe("requests made over plain HTTP", () => {
  it("rewrites what a Change renamed and shows what it removed, sent or read", async () => {
    const text = [
      "import requests",
      "",
      'STRIPE = "https://api.stripe.com"',
      "",
      "",
      "def cancel(sub_id):",
      '    params = {"cancel_at": 1, "prorate": True}',
      '    response = requests.post(f"{STRIPE}/v1/subscriptions/{sub_id}", data=params)',
      "    body = response.json()",
      '    return body["cancel_at"], body.get("current_period_end")',
      "",
      "",
      "def search():",
      '    return requests.get(f"{STRIPE}/v1/subscriptions/search").json()["cancel_at"]',
      "",
      "",
      "def elsewhere():",
      '    return requests.get("https://example.com/v1/subscriptions/x").json()["cancel_at"]',
      "",
    ].join("\n");
    const changes = [
      {
        irVersion: 1,
        id: "chg_prorate",
        summary: "`prorate` is now `proration_behavior`.",
        scopes: [
          { operation: "PostSubscriptionsSubscriptionExposedId", location: "body" },
        ],
        ops: [{ op: "move", from: "/prorate", to: "/proration_behavior" }],
      },
      {
        irVersion: 1,
        id: "chg_cancel_at",
        summary: "`cancel_at` is now `cancels_at`.",
        scopes: [{ schema: "#/components/schemas/subscription" }],
        ops: [
          { op: "move", from: "/cancel_at", to: "/cancels_at" },
          { op: "remove", path: "/current_period_end", restore: null },
        ],
      },
    ] as Change[];
    const tree = await parsePython(text);
    const result: EngineResult = { edits: [], manual: [] };
    wireSites("app.py", text, tree, { changes, wire: { servers, operations } }, result);
    const migrated = applyEdits("app.py", text, result.edits);
    // The request's own `cancel_at` is a body parameter no Change touched.
    expect(migrated).toContain('params = {"cancel_at": 1, "proration_behavior": True}');
    expect(migrated).toContain(
      'return body["cancels_at"], body.get("current_period_end")',
    );
    // A search result is not a subscription, and example.com is not the API.
    expect(migrated).toContain('.json()["cancel_at"]\n\n\ndef elsewhere');
    expect(migrated).toContain('x").json()["cancel_at"]');
    expect(result.manual.map((site) => [site.line, site.reason])).toEqual([
      [
        10,
        "`current_period_end` is no longer in the contract, and nothing was declared in its place; read here from the response of POST /v1/subscriptions/{subscription_exposed_id}, a subscription",
      ],
    ]);
    tree.delete();
  });
});
