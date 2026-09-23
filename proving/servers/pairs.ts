/**
 * Rig D's results, and what they add up to. Pure, so the scoreboard and the
 * tests read the same arithmetic the harness writes.
 */

export type Outcome = "passed" | "failed" | "skipped";

export interface ArmResult {
  outcomes: Record<string, Outcome>;
  /** The first lines of what each failing test said, by test id. */
  messages?: Record<string, string>;
  /** Set when the arm could not run at all. */
  error?: string;
}

/** What the product made of the release, read the way `invariant check` reports it. */
export interface GateSummary {
  /** Where the Changes came from: committed beside the manifest, or drafted by the proposer on the spot. */
  changesFrom: "recorded" | "drafted";
  /** Changes the proposer drafted, when they were drafted here. */
  drafted: number;
  result: "pass" | "warn" | "block";
  /** Breaking deltas no Change accounts for. */
  unexplained: string[];
  /** Declared Changes the compiled program cannot carry out, and other problems applying them. */
  unservable: string[];
  /** Breaking deltas a behavior Change acknowledges without transforming. */
  accounted: number;
}

export interface PairResult {
  project: string;
  language: string;
  from: string;
  to: string;
  changes: number;
  gate: GateSummary;
  arms: { a: ArmResult; b: ArmResult; c: ArmResult };
  /** Passed against the old server. */
  valid: number;
  /** Valid, and broken by the release: what the adapter has to fix. */
  broken: string[];
  /** Broken, and passing through the adapter. */
  served: string[];
  /** Passing without the adapter and failing through it. Must be empty. */
  regressions: string[];
}

/** A project that was looked at and left out, and why, so the list is honest. */
export interface Skipped {
  name: string;
  language: string;
  reason: string;
}

/** Test id to outcome, and to the start of what a failing test said, read from a JUnit report. */
export function readJunit(xml: string): Pick<ArmResult, "outcomes" | "messages"> {
  const outcomes: Record<string, Outcome> = {};
  const messages: Record<string, string> = {};
  const cases = xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g);
  for (const [, attributes = "", body = ""] of cases) {
    const attribute = (name: string) =>
      new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? "";
    const id = `${attribute("classname")}::${attribute("name")}`;
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (failure) {
      outcomes[id] = "failed";
      const message =
        /\bmessage="([^"]*)"/.exec(failure[2] ?? "")?.[1] ?? failure[3] ?? "";
      messages[id] = unescapeXml(message).trim().slice(0, 400);
    } else {
      outcomes[id] = /<skipped\b/.test(body) ? "skipped" : "passed";
    }
  }
  return { outcomes, messages };
}

function unescapeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

export function compareArms(arms: {
  a: ArmResult;
  b: ArmResult;
  c: ArmResult;
}): Pick<PairResult, "valid" | "broken" | "served" | "regressions"> {
  const valid = Object.keys(arms.a.outcomes).filter(
    (id) => arms.a.outcomes[id] === "passed",
  );
  const broken = valid.filter((id) => arms.b.outcomes[id] !== "passed");
  const served = broken.filter((id) => arms.c.outcomes[id] === "passed");
  // An arm that never ran regressed nothing; it is reported as not having run.
  const regressions = arms.c.error
    ? []
    : valid.filter(
        (id) => arms.b.outcomes[id] === "passed" && arms.c.outcomes[id] !== "passed",
      );
  return { valid: valid.length, broken, served, regressions };
}

/**
 * What a pair proves.
 *
 * `vacuous`: the old suite passed nothing, or passed the new server without
 * help, so the release broke nothing it exercises and the pair says nothing
 * about the adapter. `served`: every test the release broke passes through
 * the proxy, and nothing that passed without it fails with it. Anything else
 * is `unserved`.
 */
export function verdict(result: PairResult): "vacuous" | "served" | "unserved" {
  if (result.arms.a.error || result.arms.b.error || result.valid === 0) return "vacuous";
  if (result.broken.length === 0) return "vacuous";
  return result.served.length === result.broken.length &&
    result.regressions.length === 0 &&
    !result.arms.c.error
    ? "served"
    : "unserved";
}

export interface Tally {
  /** Projects with at least one release that broke their own old suite and was served in full. */
  proven: string[];
  languages: string[];
  /** Pairs the release broke, and of those, the ones fully served. */
  breaking: number;
  servedPairs: number;
  broken: number;
  served: number;
  regressions: number;
  vacuous: number;
}

/**
 * L7, counted, as the gate line words it: a project counts once one real
 * breaking release of its own broke its old suite and the adapter served
 * every broken test with no regression. Every other pair it runs is still
 * reported beside it, served or not, so an easy release cannot hide a hard
 * one from whoever reads the table.
 */
export function tally(results: readonly PairResult[]): Tally {
  const byProject = new Map<string, PairResult[]>();
  for (const result of results) {
    byProject.set(result.project, [...(byProject.get(result.project) ?? []), result]);
  }
  const proven: string[] = [];
  const languages = new Set<string>();
  for (const [project, pairs] of byProject) {
    if (pairs.some((pair) => verdict(pair) === "served")) {
      proven.push(project);
      languages.add(pairs[0]?.language ?? "");
    }
  }
  const breaking = results.filter((result) => verdict(result) !== "vacuous");
  return {
    proven: proven.sort(),
    languages: [...languages].sort(),
    breaking: breaking.length,
    servedPairs: breaking.filter((result) => verdict(result) === "served").length,
    broken: breaking.reduce((sum, result) => sum + result.broken.length, 0),
    served: breaking.reduce((sum, result) => sum + result.served.length, 0),
    regressions: results.reduce((sum, result) => sum + result.regressions.length, 0),
    vacuous: results.length - breaking.length,
  };
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

export function render(
  results: readonly PairResult[],
  skipped: readonly Skipped[] = [],
): string {
  const counted = tally(results);
  const lines = [
    "# Real servers",
    "",
    "Rig D. Each project's own released images, across a breaking release of",
    "their own, exercised by the old release's own client or API suite,",
    "unmodified. Arm a runs it against the old server, arm b against the new",
    "one, arm c against the new one through the proxy running the program the",
    "product compiles from the release's Changes. Generated by",
    "`pnpm proving:servers`.",
    "",
    `${counted.proven.length} projects proven in ${counted.languages.length} languages` +
      `${counted.proven.length > 0 ? ` (${counted.proven.join(", ")})` : ""}; ` +
      `${counted.servedPairs} of ${counted.breaking} breaking release pairs served in full, ` +
      `${counted.served} of ${counted.broken} broken tests, ${counted.regressions} regressions.`,
    "",
    "| Project | Release | Changes | Gate | Valid tests | Broken by the release | Served through the adapter | Regressions | Verdict |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const result of results) {
    const failed = Object.entries(result.arms)
      .filter(([, arm]) => arm.error)
      .map(([name, arm]) => `arm ${name}: ${cell(arm.error ?? "")}`);
    const gate = result.gate;
    const changes = `${result.changes} ${gate.changesFrom}`;
    lines.push(
      `| ${result.project} (${result.language}) | ${result.from} -> ${result.to} | ${changes} | ${gate.result} | ${result.valid} | ${result.broken.length} | ${result.served.length} | ${result.regressions.length}${failed.length ? `; ${failed.join("; ")}` : ""} | ${verdict(result)} |`,
    );
  }
  lines.push("");

  if (skipped.length > 0) {
    lines.push("## Skipped", "", "| Project | Language | Why |", "|---|---|---|");
    for (const entry of skipped) {
      lines.push(`| ${entry.name} | ${entry.language} | ${cell(entry.reason)} |`);
    }
    lines.push("");
  }

  for (const result of results) {
    const unserved = result.broken.filter((id) => !result.served.includes(id));
    const gate = result.gate;
    const gateLines = [...gate.unexplained, ...gate.unservable];
    if (
      unserved.length === 0 &&
      result.regressions.length === 0 &&
      gateLines.length === 0
    ) {
      continue;
    }
    lines.push(`## ${result.project} ${result.from} -> ${result.to}`, "");
    if (gateLines.length > 0) {
      lines.push(`The gate ${gate.result === "block" ? "blocks" : "reports"}:`, "");
      for (const line of gateLines.slice(0, 20)) lines.push(`- ${line}`);
      if (gateLines.length > 20) lines.push(`- and ${gateLines.length - 20} more`);
      lines.push("");
    }
    if (result.regressions.length > 0) {
      lines.push("Passing without the adapter and failing through it:", "");
      for (const id of result.regressions) {
        lines.push(`- \`${id}\`${said(result.arms.c, id)}`);
      }
      lines.push("");
    }
    if (unserved.length > 0) {
      lines.push("Broken by the release and not yet served:", "");
      // What it said through the proxy, when it got that far; otherwise what
      // the release did to it.
      for (const id of unserved.slice(0, 40)) {
        const arm = result.arms.c.messages?.[id] ? result.arms.c : result.arms.b;
        lines.push(`- \`${id}\`${said(arm, id)}`);
      }
      if (unserved.length > 40) lines.push(`- and ${unserved.length - 40} more`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function said(arm: ArmResult, id: string): string {
  const message = arm.messages?.[id]?.split("\n")[0]?.slice(0, 160);
  return message ? `: ${cell(message)}` : "";
}
