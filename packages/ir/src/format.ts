/**
 * The compiled program's format, and the runtimes that can run it.
 *
 * A program is compiled by the CLI in a provider's CI and run by the runtime
 * in their service, and the two are upgraded separately. A newer program on an
 * older runtime has to either work or be refused with an error that says which
 * runtime it needs (launch gate L17), never half-run: an instruction the
 * runtime did not know about, skipped, is a response in a shape nobody
 * promised. So a program says what compiled it and the oldest runtime that
 * can run everything in it, worked out from what it actually uses, and a
 * program that uses nothing new keeps running on runtimes that predate the
 * compiler that built it.
 */
import type { CompiledProgram, Instr } from "./program.ts";
import { VERSION } from "./version.ts";

/**
 * The version of the program format. Raised only for a change an older
 * runtime would misread rather than refuse; anything an older runtime would
 * refuse at load is a new feature, below, instead.
 */
export const PROGRAM_VERSION = 2;

/** The product version this package was released as, which the compiler records. */
export const PRODUCT_VERSION = VERSION;

/** Every part of the program format a runtime might not have. */
export type ProgramFeature =
  | Instr["k"]
  | "envelope"
  | "form"
  | "outbound"
  | "contract-blocks"
  | "program-blocks"
  | "base-path"
  | "retired"
  | "behaviors";

/**
 * The first runtime release that runs each feature.
 *
 * A feature added after a release is entered at the version it will ship in,
 * which is always later than any runtime already published, so a runtime that
 * predates it refuses the program instead of misreading it. Typed as a record
 * over every instruction kind, so a new instruction does not compile until it
 * is entered here.
 */
export const FEATURE_SINCE: Readonly<Record<ProgramFeature, string>> = {
  move: "0.1.0",
  scale: "0.1.0",
  enum: "0.1.0",
  cast: "0.1.0",
  time: "0.1.0",
  case: "0.1.0",
  wrap: "0.1.0",
  unwrap: "0.1.0",
  set: "0.1.0",
  del: "0.1.0",
  within: "0.1.0",
  switch: "0.1.0",
  has: "0.1.0",
  is: "0.1.0",
  call: "0.1.0",
  envelope: "0.1.0",
  form: "0.1.0",
  outbound: "0.1.0",
  "contract-blocks": "0.1.0",
  "program-blocks": "0.1.0",
  "base-path": "0.1.0",
  retired: "0.1.0",
  behaviors: "0.1.0",
};

function instrFeatures(list: readonly Instr[], into: Set<ProgramFeature>): void {
  for (const instr of list) {
    into.add(instr.k);
    if (instr.k === "within" || instr.k === "has" || instr.k === "is") {
      instrFeatures(instr.block, into);
    } else if (instr.k === "switch") {
      for (const block of Object.values(instr.cases)) instrFeatures(block, into);
    }
  }
}

/** The features a program uses. */
export function featuresOf(program: Omit<CompiledProgram, "minRuntime" | "compiledBy">) {
  const used = new Set<ProgramFeature>();
  if (program.basePath !== undefined) used.add("base-path");
  if (program.blocks) {
    used.add("program-blocks");
    for (const list of Object.values(program.blocks)) instrFeatures(list, used);
  }
  for (const contract of Object.values(program.contracts)) {
    if (contract.basePath !== undefined) used.add("base-path");
    if (contract.retired.length > 0) used.add("retired");
    if (contract.behaviors.length > 0) used.add("behaviors");
    if (contract.blocks) {
      used.add("contract-blocks");
      for (const list of Object.values(contract.blocks)) instrFeatures(list, used);
    }
    if (contract.outbound) {
      used.add("outbound");
      for (const list of Object.values(contract.outbound)) instrFeatures(list, used);
    }
    for (const site of Object.values(contract.sites)) {
      if (site.form) used.add("form");
      if (site.request) instrFeatures(site.request, used);
      if (site.envelope) {
        used.add("envelope");
        instrFeatures(site.envelope.instrs, used);
      }
      for (const list of Object.values(site.response ?? {})) instrFeatures(list, used);
    }
  }
  return used;
}

/** Orders two `major.minor.patch` versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = "", pre] = version.split("-", 2);
    return { parts: core.split(".").map((part) => Number(part) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** The oldest runtime that runs every feature a program uses. */
export function minRuntimeFor(
  program: Omit<CompiledProgram, "minRuntime" | "compiledBy">,
): string {
  let oldest = "0.1.0";
  for (const feature of featuresOf(program)) {
    const since = FEATURE_SINCE[feature];
    if (compareVersions(since, oldest) > 0) oldest = since;
  }
  return oldest;
}

/**
 * A program as it behaves, without the note of what compiled it.
 *
 * Two releases of the compiler that produce the same instructions have
 * produced the same program, so digests and "is this still what the Changes
 * compile to" compare this. Otherwise every CLI upgrade would make a committed
 * program look stale and a bundle built by one release fail to reproduce on
 * the next, while nothing a caller could observe had changed.
 */
export function withoutProvenance<T extends { compiledBy?: string }>(
  program: T,
): Omit<T, "compiledBy"> {
  const { compiledBy: _, ...rest } = program;
  return rest;
}
