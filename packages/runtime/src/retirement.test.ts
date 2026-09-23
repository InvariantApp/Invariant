/**
 * What a caller on an old contract is told about its end.
 *
 * A provider who has decided when a contract stops being served knows it; the
 * callers who have to act on it often do not, because it was written in a
 * changelog they never read. The two headers for saying it are standard, and
 * what the provider wrote in `invariant.yaml` is what the runtime sends.
 */
import { describe, expect, it } from "vitest";
import { createRuntime } from "./index.ts";

const program = (contract: Record<string, unknown>) => ({
  irVersion: 2,
  api: "acme",
  current: "sha256:abc",
  currentLabel: "2026-09-20",
  contracts: {
    "2026-01-15": {
      label: "2026-01-15",
      routes: [],
      sites: { "get /v1/things/{id}": { response: { "200": [] } } },
      behaviors: [],
      ...contract,
    },
  },
});

const answered = async (
  contract: Record<string, unknown>,
  headers: Record<string, string> = {},
) => {
  const runtime = createRuntime({
    program: program(contract),
    identity: [{ kind: "header", name: "acme-version" }],
  });
  const site = runtime.siteFor("2026-01-15", "GET", "/v1/things/1");
  return runtime.adaptResponse(
    site,
    new Response(JSON.stringify({ id: "1" }), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    }),
    { contract: "2026-01-15", operation: "getThing" },
    { encoded: false },
  );
};

describe("a contract with an end", () => {
  it("tells its callers when it was deprecated and when it stops", async () => {
    const response = await answered({
      deprecated: "2026-06-01T00:00:00.000Z",
      sunset: "2026-12-31T00:00:00.000Z",
    });
    // RFC 9745: a date, as a structured-field item.
    expect(response.headers.get("deprecation")).toBe("@1780272000");
    // RFC 8594: an HTTP date.
    expect(response.headers.get("sunset")).toBe("Thu, 31 Dec 2026 00:00:00 GMT");
  });

  it("says nothing where the provider declared nothing", async () => {
    const response = await answered({});
    expect(response.headers.get("deprecation")).toBeNull();
    expect(response.headers.get("sunset")).toBeNull();
  });

  it("leaves what the provider's own code already said", async () => {
    const response = await answered(
      { sunset: "2026-12-31T00:00:00.000Z" },
      { sunset: "Wed, 01 Jul 2026 00:00:00 GMT" },
    );
    expect(response.headers.get("sunset")).toBe("Wed, 01 Jul 2026 00:00:00 GMT");
  });
});
