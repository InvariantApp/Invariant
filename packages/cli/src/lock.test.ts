/**
 * invariant.lock and the runtime's check of it: the digest the CLI writes is
 * the one the runtime computes, so a program changed after it was compiled is
 * refused at load, and a lock left out checks nothing.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRuntime, ProgramError, programDigest } from "@invariant-app/runtime";
import { describe, expect, it } from "vitest";
import { lockFor } from "./lock.ts";

const PROGRAM = new URL(
  "../../../fixtures/provider-acme/invariant/compiled/program.json",
  import.meta.url,
);
const program = () =>
  JSON.parse(readFileSync(PROGRAM, "utf8")) as Record<string, unknown>;

describe("invariant.lock", () => {
  it("names the program by the digest the runtime computes for it", () => {
    const lock = lockFor(program(), "program.json");
    expect(lock.program).toBe("program.json");
    expect(lock.programDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(programDigest(program())).toBe(lock.programDigest);
  });

  it("ignores which CLI compiled the program, as the bundle's digest does", () => {
    const lock = lockFor(program(), "program.json");
    expect(programDigest({ ...program(), compiledBy: "someone else" })).toBe(
      lock.programDigest,
    );
  });

  it("is loaded against: the program it names runs, one changed after compiling is refused", () => {
    const { programDigest: digest } = lockFor(program(), "program.json");
    expect(() =>
      createRuntime({ program: program(), programDigest: digest }),
    ).not.toThrow();
    const tampered = program();
    tampered["currentLabel"] = "2099-01-01";
    expect(() => createRuntime({ program: tampered, programDigest: digest })).toThrow(
      ProgramError,
    );
    expect(() => createRuntime({ program: tampered, programDigest: digest })).toThrow(
      /invariant\.lock/,
    );
  });

  it("hashes with SHA-256, however long the input", () => {
    for (const text of [
      "",
      "abc",
      "x".repeat(55),
      "y".repeat(56),
      "z".repeat(64),
      "é".repeat(1000),
    ]) {
      expect(programDigest(text)).toBe(
        `sha256:${createHash("sha256").update(JSON.stringify(text), "utf8").digest("hex")}`,
      );
    }
  });
});
