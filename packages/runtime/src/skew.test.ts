/**
 * Artifact skew (launch gate L17): a program is compiled by the CLI in the
 * provider's CI and run by whatever runtime their service has installed, and
 * the two are upgraded separately. A program this runtime cannot run is
 * refused at load with an error that says so, before any of it is run.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createRuntime,
  PROGRAM_VERSION,
  ProgramError,
  ProgramTooNewError,
  RUNTIME_VERSION,
} from "./index.ts";

const COMPILED = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/provider-acme/invariant/compiled/program.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, unknown>;

const load = (program: unknown) =>
  createRuntime({ program, identity: [{ kind: "default", label: "2026-01-15" }] });

const refusal = (program: unknown): unknown => {
  try {
    load(program);
  } catch (error) {
    return error;
  }
  throw new Error("the program was loaded");
};

describe("a program and the runtime that runs it", () => {
  it("runs what the compiler of the same release produces", () => {
    expect(COMPILED["irVersion"]).toBe(PROGRAM_VERSION);
    expect(COMPILED["minRuntime"]).toBe(RUNTIME_VERSION);
    expect(() => load(COMPILED)).not.toThrow();
  });

  it("refuses a program that needs a newer runtime, saying which", () => {
    const error = refusal({ ...COMPILED, minRuntime: "99.0.0" });
    expect(error).toBeInstanceOf(ProgramTooNewError);
    expect((error as ProgramTooNewError).code).toBe("invariant_program_too_new");
    expect((error as Error).message).toContain("runtime 99.0.0");
    expect((error as Error).message).toContain(RUNTIME_VERSION);
    expect((error as Error).message).toContain(String(COMPILED["compiledBy"]));
  });

  it("says which runtime it needs before anything it does not recognise", () => {
    // A newer program's new parts are exactly what an older runtime cannot
    // read, so being told a key is unknown would hide the answer.
    const error = refusal({
      ...COMPILED,
      minRuntime: "99.0.0",
      streams: {},
      contracts: { later: { label: "later", sites: {}, pipelines: [] } },
    });
    expect(error).toBeInstanceOf(ProgramTooNewError);
  });

  it("refuses a newer program format as too new", () => {
    const error = refusal({ ...COMPILED, irVersion: PROGRAM_VERSION + 1 });
    expect(error).toBeInstanceOf(ProgramTooNewError);
    expect((error as Error).message).toContain(`program format ${PROGRAM_VERSION + 1}`);
  });

  it("still refuses, never half-runs, a newer instruction whose program forgot to say so", () => {
    const contracts = COMPILED["contracts"] as Record<string, Record<string, unknown>>;
    const oldest = contracts["2026-01-15"] as { sites: Record<string, unknown> };
    const error = refusal({
      ...COMPILED,
      contracts: {
        ...contracts,
        "2026-01-15": {
          ...oldest,
          sites: {
            ...oldest.sites,
            "post /v1/later": {
              request: [{ k: "reticulate", path: "/a", c: "chg_later" }],
            },
          },
        },
      },
    });
    expect(error).toBeInstanceOf(ProgramError);
  });

  it("refuses a program in an older format, asking for it to be compiled again", () => {
    const error = refusal({ ...COMPILED, irVersion: 1 });
    expect(error).toBeInstanceOf(ProgramError);
    expect(error).not.toBeInstanceOf(ProgramTooNewError);
    expect((error as Error).message).toMatch(/Compile the program again/);
  });

  it("runs a program that does not say which runtime it needs", () => {
    const { minRuntime: _, compiledBy: __, ...unstated } = COMPILED;
    expect(() => load(unstated)).not.toThrow();
  });
});
