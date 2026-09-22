/**
 * `invariant doctor`: everything that has to be true for the gate to be right,
 * checked in one place, each with the fix beside it.
 *
 * Most of what goes wrong in adopting a tool like this is not a bug in it: the
 * wrong Node, a binary without its executable bit, a specification that no
 * longer loads, a compiled program nobody regenerated after editing a Change.
 * The last one is the dangerous one. The program ships inside the provider's
 * build, and a stale one serves old callers yesterday's translation while the
 * gate reports today's Changes as passing.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { digestOf, loadContract, loadPendingChanges } from "@invariant-app/contract";
import { assertUsableOasdiff, OASDIFF_VERSION, oasdiffBinary } from "@invariant-app/diff";
import { BRAND, type JsonValue, withoutProvenance } from "@invariant-app/ir";
import { check } from "./check.ts";
import type { InvariantConfig } from "./config.ts";

export type Severity = "ok" | "warn" | "error";

export interface Finding {
  severity: Severity;
  what: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

const NODE_FLOOR = [22, 12] as const;

function nodeFinding(version: string = process.versions.node): Finding {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const ok = major > NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor >= NODE_FLOOR[1]);
  return ok
    ? { severity: "ok", what: `Node ${version}` }
    : {
        severity: "error",
        what: `Node ${version} is older than ${NODE_FLOOR.join(".")}`,
        fix: `Use Node ${NODE_FLOOR.join(".")} or later.`,
      };
}

async function oasdiffFinding(): Promise<Finding> {
  const binary = oasdiffBinary();
  const source = process.env["OASDIFF_BIN"]
    ? "OASDIFF_BIN"
    : binary === "oasdiff"
      ? "PATH"
      : "the platform package";
  try {
    await assertUsableOasdiff();
    return { severity: "ok", what: `oasdiff from ${source}: ${binary}` };
  } catch (error) {
    return {
      severity: "error",
      what: error instanceof Error ? error.message : String(error),
      fix: `Reinstall ${BRAND.scope}/cli, or install oasdiff ${OASDIFF_VERSION} and set OASDIFF_BIN.`,
    };
  }
}

export interface DoctorOptions {
  /** Where the compiled program lives, relative to the repository. */
  program?: string;
}

export async function doctor(
  config: InvariantConfig,
  options: DoctorOptions = {},
): Promise<Finding[]> {
  const findings: Finding[] = [nodeFinding(), await oasdiffFinding()];

  // Every contract the configuration names has to load, or every later answer
  // is about a document that does not exist.
  const specs: [string, string][] = [
    ["current", config.currentSpec],
    ...[...config.releasedSpecs].map(([label, path]): [string, string] => [label, path]),
  ];
  for (const [label, path] of specs) {
    try {
      await loadContract(path, label);
      findings.push({
        severity: "ok",
        what: `${label} loads from ${relative(config.root, path)}`,
      });
    } catch (error) {
      findings.push({
        severity: "error",
        what: `${label} does not load from ${relative(config.root, path)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  if (config.currentLabel === undefined) {
    findings.push({
      severity: "warn",
      what: "spec.currentLabel is not set, so each day's build names the contract differently",
      fix: "Set spec.currentLabel to the name of the contract this branch builds.",
    });
  }

  try {
    const pending = await loadPendingChanges(config.invariantDir);
    findings.push({
      severity: "ok",
      what: `${pending.length} pending Change ${pending.length === 1 ? "file" : "files"} parse`,
    });
  } catch (error) {
    findings.push({
      severity: "error",
      what: `a pending Change does not parse: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // The compiled program against what the Changes compile to now.
  const programPath = join(
    config.root,
    options.program ?? "invariant/compiled/program.json",
  );
  if (!existsSync(programPath)) {
    findings.push({
      severity: "warn",
      what: `no compiled program at ${relative(config.root, programPath)}`,
      fix: `Run "${BRAND.command} compile" if this API serves old contracts through the runtime.`,
    });
  } else if (findings.every((finding) => finding.severity !== "error")) {
    const shipped = JSON.parse(await readFile(programPath, "utf8")) as {
      compiledBy?: string;
    };
    const report = await check(config);
    if (!report.program) {
      findings.push({
        severity: "error",
        what: "the release does not pass the gate, so no current program exists to compare",
        fix: `Run "${BRAND.command} check" for the reasons.`,
      });
    } else if (
      // Compiled by an older CLI but otherwise the same is not stale.
      digestOf(withoutProvenance(report.program) as unknown as JsonValue) !==
      digestOf(withoutProvenance(shipped) as unknown as JsonValue)
    ) {
      findings.push({
        severity: "error",
        what:
          `${relative(config.root, programPath)} is not what the Changes compile to now, ` +
          "so the build would serve old callers a translation nobody checked",
        fix: `Run "${BRAND.command} compile" and commit the result.`,
      });
    } else {
      findings.push({
        severity: "ok",
        what: `${relative(config.root, programPath)} matches the Changes`,
      });
    }
  }

  const workflows = join(config.root, ".github", "workflows");
  if (!existsSync(workflows)) {
    findings.push({
      severity: "warn",
      what: "no GitHub Actions workflows, so nothing runs the gate on a pull request",
      fix: `Add the action from "${BRAND.command} init", or run "${BRAND.command} check" in your CI.`,
    });
  }

  return findings;
}

export function renderDoctor(findings: readonly Finding[]): string {
  const mark: Record<Severity, string> = { ok: "ok  ", warn: "warn", error: "FAIL" };
  const lines = findings.flatMap((finding) => [
    `${mark[finding.severity]}  ${finding.what}`,
    ...(finding.fix ? [`      ${finding.fix}`] : []),
  ]);
  const errors = findings.filter((finding) => finding.severity === "error").length;
  lines.push(
    "",
    errors === 0
      ? "Nothing is wrong."
      : `${errors} ${errors === 1 ? "thing" : "things"} to fix.`,
  );
  return lines.join("\n");
}
