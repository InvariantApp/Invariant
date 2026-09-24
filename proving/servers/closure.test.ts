import { describe, expect, it } from "vitest";
import { type Exchange, type Json, judgeClosure, route, written } from "./closure.ts";

const call = (id: number, body: Json, status = 200, path = "/items/42"): Exchange => ({
  id,
  method: "GET",
  path,
  status,
  body,
});

describe("judging adapted answers against the old server", () => {
  it("sets ids aside when naming a route", () => {
    expect(
      route("get", "/repos/octo/7f3e2a1b-0c4d-4e5f-8a9b-0c1d2e3f4a5b/issues/12"),
    ).toBe("GET /repos/octo/{id}/issues/{id}");
  });

  it("finds what the adapter wrote and what it took away", () => {
    expect(written({ bytes: 1, kept: true }, { size: 1, kept: true })).toEqual({
      changed: ["/size"],
      removed: ["/bytes"],
    });
  });

  it("passes a rename that gives the old caller the old server's value", () => {
    const result = judgeClosure(
      [{ given: [call(0, { size_kb: 2 })], sent: [call(0, { size: 2 })] }],
      [[call(0, { size: 2 })], [call(0, { size: 2 })]],
    );
    expect(result).toMatchObject({ adapted: 1, compared: 1, wrong: [] });
    expect(result.sites).toEqual(["GET /items/{id} /size", "GET /items/{id} /size_kb"]);
  });

  it("catches a rename that should have converted", () => {
    const result = judgeClosure(
      [{ given: [call(0, { size_kb: 2 })], sent: [call(0, { size: 2 })] }],
      [[call(0, { size: 2048 })], [call(0, { size: 2048 })]],
    );
    expect(result.wrong).toHaveLength(1);
    expect(result.wrong[0]?.why).toMatch(
      /sent 2 where the old server sent 2048 on every run/,
    );
  });

  it("compares only the kind of a value the old server itself varies", () => {
    const result = judgeClosure(
      [{ given: [call(0, { made_at: "b" })], sent: [call(0, { created: "x" })] }],
      [[call(0, { created: "y" })], [call(0, { created: "z" })]],
    );
    expect(result.wrong).toEqual([]);
    const typed = judgeClosure(
      [{ given: [call(0, { made_at: 1 })], sent: [call(0, { created: 1 })] }],
      [[call(0, { created: "y" })], [call(0, { created: "z" })]],
    );
    expect(typed.wrong[0]?.why).toMatch(/number 1 where the old server sent string/);
  });

  it("catches a value invented where the old server sent nothing", () => {
    const result = judgeClosure(
      [{ given: [call(0, {})], sent: [call(0, { region: "eu" })] }],
      [[call(0, {})], [call(0, {})]],
    );
    expect(result.wrong[0]?.site).toBe("GET /items/{id} /region");
    expect(result.wrong[0]?.why).toMatch(/at \/ it sent an object holding nothing/);
  });

  it("says whether the field alone was missing or everything around it was", () => {
    const result = judgeClosure(
      [
        {
          given: [call(0, { app: { features: { gpu: false } } })],
          sent: [
            {
              ...call(0, { app: { features: { gpu: false, web: true } } }),
              query: "?level=1",
            },
          ],
        },
      ],
      [[call(0, { app: { name: "q" } })], [call(0, { app: { name: "q" } })]],
    );
    expect(result.wrong[0]?.why).toBe(
      "the adapter sent true where the old server sent nothing " +
        "(at /app it sent an object holding name, GET /items/42?level=1)",
    );
  });

  it("does not judge against an old answer whose body was not recorded", () => {
    const unrecorded: Exchange = { id: 0, method: "GET", path: "/items/42", status: 200 };
    const result = judgeClosure(
      [{ given: [call(0, {})], sent: [call(0, { region: "eu" })] }],
      [[unrecorded], [call(0, {})]],
    );
    expect(result).toMatchObject({
      adapted: 1,
      compared: 0,
      notComparable: 1,
      wrong: [],
    });
  });

  it("does not charge a Change for a status the release changed and the adapter passed on", () => {
    const result = judgeClosure(
      [{ given: [call(0, { a: 1 }, 404)], sent: [call(0, { b: 1 }, 404)] }],
      [[call(0, { b: 1 })], [call(0, { b: 1 })]],
    );
    expect(result).toMatchObject({
      adapted: 1,
      compared: 0,
      notComparable: 1,
      wrong: [],
    });
  });

  it("pairs calls to one route by the order they were made in", () => {
    const result = judgeClosure(
      [
        {
          given: [call(0, { n: 1 }), call(1, { n: 2 })],
          sent: [call(0, { count: 1 }), call(1, { count: 2 })],
        },
      ],
      [
        [call(5, { count: 1 }), call(9, { count: 2 })],
        [call(3, { count: 1 }), call(4, { count: 2 })],
      ],
    );
    expect(result).toMatchObject({ adapted: 2, compared: 2, wrong: [] });
  });

  it("leaves an answer the adapter did not change alone", () => {
    const result = judgeClosure(
      [{ given: [call(0, { same: 1 })], sent: [call(0, { same: 1 })] }],
      [[call(0, { same: 2 })]],
    );
    expect(result).toMatchObject({ adapted: 0, compared: 0, wrong: [] });
  });
});
