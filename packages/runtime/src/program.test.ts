/**
 * The decoder is where a build artifact becomes something that runs against
 * live traffic. Everything it will not accept is as important as what it will.
 */
import { describe, expect, it } from "vitest";
import { decodeProgram, findSite, matchTemplate, ProgramError } from "./program.ts";

function program(sites: Record<string, unknown>, routes: unknown[] = []): unknown {
  return {
    irVersion: 1,
    api: "acme",
    current: "sha256:abc",
    currentLabel: "2026-09-20",
    contracts: {
      "2026-01-15": { label: "2026-01-15", routes, sites, behaviors: [] },
    },
  };
}

const MOVE = { k: "move", from: "/a", to: "/b", c: "chg" };

describe("decoding", () => {
  it("accepts a well-formed program", () => {
    const decoded = decodeProgram(program({ "post /v1/things": { request: [MOVE] } }));
    expect(decoded.currentLabel).toBe("2026-09-20");
    expect(decoded.contracts.get("2026-01-15")?.sites.size).toBe(1);
  });

  it("refuses an IR version it does not implement", () => {
    const value = program({}) as Record<string, unknown>;
    value["irVersion"] = 2;
    expect(() => decodeProgram(value)).toThrow(/Unsupported IR version/);
  });

  it("refuses an instruction it does not know", () => {
    expect(() =>
      decodeProgram(program({ "post /x": { request: [{ k: "exec", c: "chg" }] } })),
    ).toThrow(/unknown instruction/);
  });

  it("refuses an unexpected field rather than ignoring it", () => {
    expect(() =>
      decodeProgram(program({ "post /x": { request: [{ ...MOVE, extra: 1 }] } })),
    ).toThrow(/unexpected field "extra"/);
  });

  it("refuses a pointer that names a prototype key", () => {
    expect(() =>
      decodeProgram(
        program({ "post /x": { request: [{ ...MOVE, to: "/__proto__/x" }] } }),
      ),
    ).toThrow(/may not name "__proto__"/);
  });

  it("refuses a move whose wildcards do not line up", () => {
    expect(() =>
      decodeProgram(
        program({ "post /x": { request: [{ ...MOVE, from: "/d/*/a", to: "/b" }] } }),
      ),
    ).toThrow(/different wildcard counts/);
  });

  it("refuses a path that is not a JSON Pointer", () => {
    expect(() =>
      decodeProgram(program({ "post /x": { request: [{ ...MOVE, from: "a" }] } })),
    ).toThrow(/must be a JSON Pointer/);
  });

  it("refuses a scale exponent outside the supported range", () => {
    expect(() =>
      decodeProgram(
        program({
          "post /x": { request: [{ k: "scale", path: "/a", exp: 20, c: "chg" }] },
        }),
      ),
    ).toThrow(/between -9 and 9/);
  });

  it("refuses a response keyed by something that is not a status", () => {
    expect(() =>
      decodeProgram(program({ "post /x": { response: { ok: [MOVE] } } })),
    ).toThrow(/invalid status key/);
  });

  it("refuses a route that changes the HTTP method", () => {
    expect(() =>
      decodeProgram(
        program({}, [
          {
            from: { method: "get", path: "/a" },
            to: { method: "post", path: "/b" },
            c: "chg",
          },
        ]),
      ),
    ).toThrow(/changes the HTTP method/);
  });

  it("marks a site as numeric only when it actually needs exact digits", () => {
    const withScale = decodeProgram(
      program({ "post /x": { request: [{ k: "scale", path: "/a", exp: 2, c: "chg" }] } }),
    );
    const withoutScale = decodeProgram(program({ "post /y": { request: [MOVE] } }));
    expect(withScale.contracts.get("2026-01-15")?.sites.get("post /x")?.numeric).toBe(
      true,
    );
    expect(withoutScale.contracts.get("2026-01-15")?.sites.get("post /y")?.numeric).toBe(
      false,
    );
  });

  it("rejects a program that is not an object at all", () => {
    expect(() => decodeProgram("nope")).toThrow(ProgramError);
    expect(() => decodeProgram(null)).toThrow(ProgramError);
  });
});

describe("template matching", () => {
  it("matches a path parameter and nothing else", () => {
    expect(matchTemplate("/v1/p/{id}".split("/"), "/v1/p/abc")).toEqual(["abc"]);
    expect(matchTemplate("/v1/p/{id}".split("/"), "/v1/p")).toBeUndefined();
    expect(matchTemplate("/v1/p/{id}".split("/"), "/v1/p/abc/x")).toBeUndefined();
    expect(matchTemplate("/v1/p/{id}".split("/"), "/v1/p/")).toBeUndefined();
  });

  it("finds a site through its template", () => {
    const decoded = decodeProgram(
      program({ "get /v1/things/{id}": { response: { "200": [MOVE] } } }),
    );
    const contract = decoded.contracts.get("2026-01-15");
    expect(contract && findSite(contract, "GET", "/v1/things/abc")).toBeDefined();
    expect(contract && findSite(contract, "GET", "/v1/other/abc")).toBeUndefined();
    expect(contract && findSite(contract, "POST", "/v1/things/abc")).toBeUndefined();
  });
});
