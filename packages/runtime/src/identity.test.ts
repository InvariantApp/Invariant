/**
 * How a request names its contract, declared once and carried by the program.
 *
 * It used to be declared three times: in `invariant.yaml`, in the proxy's
 * configuration and in every binding's options, and a copy that disagreed with
 * the others served callers the wrong contract without an error anywhere.
 */
import { describe, expect, it } from "vitest";
import { createRuntime, ProgramError } from "./index.ts";

const program = (identity?: unknown) => ({
  irVersion: 2,
  api: "acme",
  current: "sha256:abc",
  currentLabel: "2026-09-20",
  contracts: {
    "2026-01-15": { label: "2026-01-15", routes: [], sites: {}, behaviors: [] },
  },
  ...(identity === undefined ? {} : { identity }),
});

const headers = (entries: Record<string, string>) => new Headers(entries);

describe("the program's identity", () => {
  const declared = [
    { kind: "header", name: "Acme-Version" },
    { kind: "default", label: "2026-01-15" },
  ];

  it("is how requests name their contract, when nothing else is given", () => {
    const runtime = createRuntime({ program: program(declared) });
    expect(
      runtime.resolve(headers({ "acme-version": "2026-09-20" }), "/x", undefined),
    ).toEqual({
      label: "2026-09-20",
      source: "header",
    });
    expect(runtime.resolve(headers({}), "/x", undefined).label).toBe("2026-01-15");
    // Compared lower-cased, as header names are on the wire.
    expect(runtime.varyOn).toEqual(["acme-version"]);
  });

  it("gives way to one passed explicitly", () => {
    const runtime = createRuntime({
      program: program(declared),
      identity: [{ kind: "default", label: "2026-09-20" }],
    });
    expect(
      runtime.resolve(headers({ "acme-version": "2026-01-15" }), "/x", undefined).label,
    ).toBe("2026-09-20");
  });

  it("must be somewhere, and says where to put it", () => {
    expect(() => createRuntime({ program: program() })).toThrow(
      /declare `identity` in invariant.yaml/,
    );
  });

  it("is refused when it is not a list of strategies this runtime knows", () => {
    expect(() => createRuntime({ program: program([]) })).toThrow(ProgramError);
    expect(() =>
      createRuntime({ program: program([{ kind: "cookie", name: "v" }]) }),
    ).toThrow(ProgramError);
    expect(() =>
      createRuntime({
        program: program([{ kind: "header", name: "v", description: "x" }]),
      }),
    ).toThrow(ProgramError);
  });

  it("is still checked against the contracts the program has", () => {
    expect(() =>
      createRuntime({ program: program([{ kind: "default", label: "1999-01-01" }]) }),
    ).toThrow(/names contract "1999-01-01"/);
  });
});
