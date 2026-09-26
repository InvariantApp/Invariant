/**
 * Scenarios from traffic a provider already recorded: a HAR file and a
 * Postman collection. What an earlier answer minted is carried into the
 * requests after it, what describes the recording rather than the request is
 * dropped, and what cannot be replayed is left out with why.
 */
import { describe, expect, it } from "vitest";
import { scenariosFromHar, scenariosFromPostman } from "./import.ts";
import { parseScenario, scenarioYaml } from "./scenarios.ts";

const entry = (
  method: string,
  url: string,
  options: {
    body?: unknown;
    response?: unknown;
    status?: number;
    mime?: string;
    page?: string;
    at?: string;
    headers?: Record<string, string>;
  } = {},
) => ({
  startedDateTime: options.at ?? "2026-09-01T10:00:00.000Z",
  ...(options.page ? { pageref: options.page } : {}),
  request: {
    method,
    url,
    headers: Object.entries({
      host: "api.example.com",
      cookie: "session=abc",
      authorization: "Bearer recorded",
      "acme-version": "2026-01-15",
      ...(options.headers ?? {}),
    }).map(([name, value]) => ({ name, value })),
    ...(options.body === undefined
      ? {}
      : {
          postData: {
            mimeType: options.mime ?? "application/json",
            text:
              typeof options.body === "string"
                ? options.body
                : JSON.stringify(options.body),
          },
        }),
  },
  response: {
    status: options.status ?? 200,
    content:
      options.response === undefined
        ? { mimeType: "text/html", text: "<html></html>" }
        : { mimeType: "application/json", text: JSON.stringify(options.response) },
  },
});

const HAR = {
  log: {
    version: "1.2",
    pages: [{ id: "page_1", title: "Pay for an order" }],
    entries: [
      entry("GET", "https://api.example.com/app.js", { at: "2026-09-01T10:00:00.000Z" }),
      entry("OPTIONS", "https://api.example.com/v1/payments", {
        at: "2026-09-01T10:00:00.500Z",
      }),
      entry("POST", "https://api.example.com/v1/payments", {
        page: "page_1",
        at: "2026-09-01T10:00:01.000Z",
        body: { amount: 1250, currency: "usd", status: "open" },
        response: {
          id: "pay_8f3a1c",
          amount: 1250,
          status: "open",
          customer: { id: "cus_42x9" },
        },
        status: 201,
      }),
      // Recorded out of order: the reader sorts by when each was sent.
      entry("POST", "https://api.example.com/v1/refunds", {
        page: "page_1",
        at: "2026-09-01T10:00:03.000Z",
        body: { payment: "pay_8f3a1c", reason: "open" },
        response: { id: "re_77", payment: "pay_8f3a1c" },
      }),
      entry("GET", "https://api.example.com/v1/payments/pay_8f3a1c?expand=cus_42x9", {
        page: "page_1",
        at: "2026-09-01T10:00:02.000Z",
        response: { id: "pay_8f3a1c", amount: 1250 },
      }),
      entry("GET", "https://api.example.com/v1/payments/missing", {
        page: "page_1",
        at: "2026-09-01T10:00:04.000Z",
        response: { error: { code: "not_found" } },
        status: 404,
      }),
      entry("POST", "https://api.example.com/v1/uploads", {
        page: "page_1",
        at: "2026-09-01T10:00:05.000Z",
        body: "name=receipt",
        mime: "application/x-www-form-urlencoded",
        response: { ok: true },
      }),
    ],
  },
};

describe("scenarios from a HAR file", () => {
  it("replays the API's requests in the order they were sent, with what the create minted carried into the rest", () => {
    const { scenarios, skipped } = scenariosFromHar(HAR, { contract: "2026-01-15" });
    expect(scenarios).toHaveLength(1);
    const [scenario] = scenarios;
    expect(scenario?.name).toBe("Pay for an order");
    expect(scenario?.contract).toBe("2026-01-15");
    expect(
      scenario?.steps.map((step) => `${step.id} ${step.method} ${step.path}`),
    ).toEqual([
      "post_v1_payments POST /v1/payments",
      `get_v1_payments GET /v1/payments/\${post_v1_payments.id}?expand=\${post_v1_payments.id_2}`,
      "post_v1_refunds POST /v1/refunds",
      "get_payments_missing GET /v1/payments/missing",
    ]);
    const [create, , refund, missing] = scenario?.steps ?? [];
    expect(create?.capture).toEqual({ id: "/id", id_2: "/customer/id" });
    // The id is linked; a plain word the client chose is left as it is.
    expect(refund?.body).toEqual({ payment: `\${post_v1_payments.id}`, reason: "open" });
    expect(missing?.expectStatus).toBe(404);
    expect(create?.expectStatus).toBeUndefined();
    expect(skipped).toEqual([
      "POST /v1/uploads: its body is application/x-www-form-urlencoded, and only JSON bodies are replayed",
    ]);
  });

  it("drops what describes the recording rather than the request, and adds the provider's own headers", () => {
    const { scenarios } = scenariosFromHar(HAR, {
      contract: "2026-01-15",
      headers: { Authorization: "Bearer test" },
    });
    expect(scenarios[0]?.steps[0]?.headers).toEqual({
      "acme-version": "2026-01-15",
      authorization: "Bearer test",
    });
    const kept = scenariosFromHar(HAR, { contract: "c", keepHeaders: ["Authorization"] });
    expect(kept.scenarios[0]?.steps[0]?.headers["authorization"]).toBe("Bearer recorded");
  });

  it("keeps only requests under the base it is given", () => {
    const { scenarios } = scenariosFromHar(HAR, {
      contract: "c",
      base: "https://api.example.com/v1/payments",
    });
    expect(scenarios[0]?.steps.map((step) => step.method)).toEqual([
      "POST",
      "GET",
      "GET",
    ]);
    expect(
      scenariosFromHar(HAR, { contract: "c", base: "/v1/refunds" }).scenarios[0]?.steps,
    ).toHaveLength(1);
  });

  it("writes a file that reads back as the same scenario", () => {
    const [scenario] = scenariosFromHar(HAR, { contract: "2026-01-15" }).scenarios;
    if (!scenario) throw new Error("no scenario");
    expect(parseScenario(scenarioYaml(scenario), "imported.yaml")).toEqual(scenario);
  });

  it("refuses a file that is not a HAR", () => {
    expect(() => scenariosFromHar({ info: {} }, { contract: "c" })).toThrow(
      /log\.entries/,
    );
  });
});

const COLLECTION = {
  info: {
    name: "Pets",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: "https://petstore.example.com" },
    { key: "species", value: "cat" },
  ],
  item: [
    {
      name: "Health",
      request: {
        method: "GET",
        url: { raw: "{{baseUrl}}/health", host: ["{{baseUrl}}"], path: ["health"] },
      },
    },
    {
      name: "Adopt",
      item: [
        {
          name: "Create a pet",
          event: [
            {
              listen: "test",
              script: {
                exec: [
                  "const data = pm.response.json();",
                  'pm.collectionVariables.set("petId", data.pet.id);',
                  'pm.environment.set("owner", computeOwner(pm.response));',
                ],
              },
            },
          ],
          request: {
            method: "POST",
            header: [
              { key: "Content-Type", value: "application/json" },
              { key: "X-Api-Version", value: "2" },
              { key: "X-Debug", value: "1", disabled: true },
            ],
            body: {
              mode: "raw",
              raw: '{ "name": "Rex", "species": "{{species}}", "tag": "{{$guid}}" }',
              options: { raw: { language: "json" } },
            },
            url: { raw: "{{baseUrl}}/pets", host: ["{{baseUrl}}"], path: ["pets"] },
          },
        },
        {
          name: "Read it back",
          request: {
            method: "GET",
            url: {
              raw: "{{baseUrl}}/pets/:pet?fields=name",
              host: ["{{baseUrl}}"],
              path: ["pets", ":pet"],
              variable: [{ key: "pet", value: "{{petId}}" }],
              query: [
                { key: "fields", value: "name" },
                { key: "debug", value: "true", disabled: true },
              ],
            },
          },
        },
        {
          name: "Rename it",
          request: {
            method: "PATCH",
            url: "{{baseUrl}}/pets/{{petId}}",
            body: { mode: "raw", raw: '{"name": "Max"}' },
          },
        },
        {
          name: "Give it an owner",
          request: {
            method: "PUT",
            url: "{{baseUrl}}/pets/{{petId}}/owner/{{owner}}",
          },
        },
        {
          name: "Upload a photo",
          request: {
            method: "POST",
            url: "{{baseUrl}}/pets/{{petId}}/photo",
            body: { mode: "formdata", formdata: [] },
          },
        },
      ],
    },
  ],
};

describe("scenarios from a Postman collection", () => {
  it("makes one scenario of the requests at the top and one per folder, with variables filled", () => {
    const { scenarios, skipped } = scenariosFromPostman(COLLECTION, { contract: "v2" });
    expect(scenarios.map((scenario) => scenario.name)).toEqual(["Pets", "Adopt"]);
    expect(scenarios[0]?.steps.map((step) => `${step.method} ${step.path}`)).toEqual([
      "GET /health",
    ]);

    const adopt = scenarios[1];
    expect(adopt?.steps.map((step) => `${step.id} ${step.method} ${step.path}`)).toEqual([
      "post_pets POST /pets",
      `get_pets GET /pets/\${post_pets.petId}?fields=name`,
      `patch_pets PATCH /pets/\${post_pets.petId}`,
    ]);
    const [create, , rename] = adopt?.steps ?? [];
    // Where the script read it from, not a guess.
    expect(create?.capture).toEqual({ petId: "/pet/id" });
    expect(create?.body).toEqual({
      name: "Rex",
      species: "cat",
      tag: "00000000-0000-4000-8000-000000000001",
    });
    expect(create?.headers).toEqual({ "x-api-version": "2" });
    expect(rename?.body).toEqual({ name: "Max" });

    expect(skipped).toEqual([
      "Adopt / Give it an owner: {{owner}} is set by a script this cannot read",
      "Adopt / Upload a photo: its body is formdata, and only JSON bodies are replayed",
    ]);
  });

  it("takes the provider's variables before the collection's, and drops a host nobody named", () => {
    const collection = { ...COLLECTION, variable: [] };
    const { scenarios, skipped } = scenariosFromPostman(collection, {
      contract: "v2",
      variables: { species: "dog", owner: "ann" },
    });
    expect(scenarios[1]?.steps[0]?.body).toMatchObject({ species: "dog" });
    expect(scenarios[1]?.steps.map((step) => step.path)).toContain(
      `/pets/\${post_pets.petId}/owner/ann`,
    );
    expect(skipped.some((line) => line.includes("owner"))).toBe(false);
  });

  it("links an id a saved example answered with, where no script names it", () => {
    const collection = {
      info: { name: "Orders" },
      item: [
        {
          name: "Create",
          request: {
            method: "POST",
            url: "{{host}}/orders",
            body: { mode: "raw", raw: "{}" },
          },
          response: [{ code: 201, body: JSON.stringify({ order_id: 9001 }) }],
        },
        { name: "Read", request: { method: "GET", url: "{{host}}/orders/9001" } },
      ],
    };
    const [scenario] = scenariosFromPostman(collection, { contract: "c" }).scenarios;
    expect(scenario?.steps.map((step) => step.path)).toEqual([
      "/orders",
      `/orders/\${post_orders.order_id}`,
    ]);
    expect(scenario?.steps[0]?.capture).toEqual({ order_id: "/order_id" });
  });

  it("refuses a file that is not a collection", () => {
    expect(() =>
      scenariosFromPostman({ log: { entries: [] } }, { contract: "c" }),
    ).toThrow(/Postman collection/);
  });
});
