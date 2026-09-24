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
  /** Tests whose outcome differed between runs of this arm, by test id. */
  volatile?: string[];
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
  /**
   * Tests whose outcome differed between two runs of one arm, against the
   * same server doing the same thing: they are left out of every count
   * above, since what they say is chance. Older results carry none.
   */
  volatile?: string[];
}

/** A project that was looked at and left out, and why, so the list is honest. */
export interface Skipped {
  name: string;
  language: string;
  reason: string;
}

/**
 * `{name}` replaced with its value, for every name given; anything else is
 * left as written. Names are a manifest's, like `url` or `NETBOX_TOKEN`.
 */
export function expand(text: string, vars: Record<string, string>): string {
  return text.replace(
    /\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (whole, name: string) => vars[name] ?? whole,
  );
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
      // gotestsum writes every failure's message as "Failed", and what the
      // test said only in the body; a message that says more is kept.
      const said = /\bmessage="([^"]*)"/.exec(failure[2] ?? "")?.[1] ?? "";
      const message = said === "" || /^failed$/i.test(said) ? (failure[3] ?? said) : said;
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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&amp;/g, "&");
}

/**
 * One arm run several times, as one result: a test's outcome where every run
 * agreed on it, and the test named volatile where they did not.
 *
 * Immich's e2e suite checks that a library scan produced thumbnails, which a
 * job makes a moment later, and Qdrant's queries a payload index it asked
 * for without waiting: each failed through the proxy once and passed the
 * next time, against the same server. Retrying a failure until it passes
 * would call chance a result; running each arm the same number of times and
 * setting aside what disagrees with itself does not.
 */
export function combineRuns(runs: readonly ArmResult[]): ArmResult {
  const broken = runs.find((run) => run.error !== undefined);
  if (broken || runs.length === 0) {
    return broken ?? { outcomes: {}, error: "the arm did not run" };
  }
  const ids = new Set(runs.flatMap((run) => Object.keys(run.outcomes)));
  const outcomes: Record<string, Outcome> = {};
  const messages: Record<string, string> = {};
  const volatile: string[] = [];
  for (const id of [...ids].sort()) {
    const seen = new Set(runs.map((run) => run.outcomes[id] ?? "skipped"));
    const first = runs.find((run) => run.outcomes[id] === "failed");
    if (first?.messages?.[id] !== undefined) messages[id] = first.messages[id];
    if (seen.size > 1) {
      volatile.push(id);
      outcomes[id] = "failed";
    } else {
      outcomes[id] = [...seen][0] as Outcome;
    }
  }
  return {
    outcomes,
    ...(Object.keys(messages).length > 0 ? { messages } : {}),
    ...(volatile.length > 0 ? { volatile } : {}),
  };
}

export function compareArms(arms: {
  a: ArmResult;
  b: ArmResult;
  c: ArmResult;
}): Pick<PairResult, "valid" | "broken" | "served" | "regressions" | "volatile"> {
  const volatile = [
    ...new Set([
      ...(arms.a.volatile ?? []),
      ...(arms.b.volatile ?? []),
      ...(arms.c.volatile ?? []),
    ]),
  ].sort();
  const steady = new Set(volatile);
  const valid = Object.keys(arms.a.outcomes).filter(
    (id) => arms.a.outcomes[id] === "passed" && !steady.has(id),
  );
  const broken = valid.filter((id) => arms.b.outcomes[id] !== "passed");
  const served = broken.filter((id) => arms.c.outcomes[id] === "passed");
  // An arm that never ran regressed nothing; it is reported as not having run.
  const regressions = arms.c.error
    ? []
    : valid.filter(
        (id) => arms.b.outcomes[id] === "passed" && arms.c.outcomes[id] !== "passed",
      );
  return {
    valid: valid.length,
    broken,
    served,
    regressions,
    ...(volatile.length > 0 ? { volatile } : {}),
  };
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
  /** Tests set aside because two runs of one arm disagreed on them. */
  volatile: number;
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
    volatile: results.reduce((sum, result) => sum + (result.volatile?.length ?? 0), 0),
  };
}

function counted(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

/** L7 in one line, as the report and the scoreboard both print it. */
export function headline(counts: Tally): string {
  return (
    `${counted(counts.proven.length, "project")} proven in ` +
    `${counted(counts.languages.length, "language")}` +
    `${counts.proven.length > 0 ? ` (${counts.proven.join(", ")})` : ""}; ` +
    `${counts.servedPairs} of ${counted(counts.breaking, "breaking release pair")} served in full, ` +
    `${counts.served} of ${counted(counts.broken, "broken test")}, ` +
    `${counted(counts.regressions, "regression")}` +
    (counts.volatile > 0
      ? `; ${counted(counts.volatile, "volatile test")} set aside`
      : "")
  );
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

export function render(
  results: readonly PairResult[],
  skipped: readonly Skipped[] = [],
): string {
  const counts = tally(results);
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
    `${headline(counts)}.`,
    "",
    "| Project | Release | Changes | Gate | Valid tests | Broken by the release | Served through the adapter | Regressions | Volatile, set aside | Verdict |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const result of results) {
    const failed = Object.entries(result.arms)
      .filter(([, arm]) => arm.error)
      .map(([name, arm]) => `arm ${name}: ${cell(arm.error ?? "")}`);
    const gate = result.gate;
    const changes = `${result.changes} ${gate.changesFrom}`;
    lines.push(
      `| ${result.project} (${result.language}) | ${result.from} -> ${result.to} | ${changes} | ${gate.result} | ${result.valid} | ${result.broken.length} | ${result.served.length} | ${result.regressions.length}${failed.length ? `; ${failed.join("; ")}` : ""} | ${result.volatile?.length ?? 0} | ${verdict(result)} |`,
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
    const volatile = result.volatile ?? [];
    if (
      unserved.length === 0 &&
      result.regressions.length === 0 &&
      gateLines.length === 0 &&
      volatile.length === 0
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
    if (volatile.length > 0) {
      lines.push(
        "Set aside, since two runs of one arm disagreed on them:",
        "",
        ...volatile.slice(0, 40).map((id) => `- \`${id}\``),
        ...(volatile.length > 40 ? [`- and ${volatile.length - 40} more`] : []),
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function said(arm: ArmResult, id: string): string {
  const lines = (arm.messages?.[id] ?? "").split("\n").map((line) => line.trim());
  // testify says where it failed on one line and what on the next ones; the
  // values it compared are what a reader needs.
  const compared = (name: string) =>
    lines
      .find((line) => new RegExp(`^${name}\\s*:`).test(line))
      ?.replace(/^\w+\s*:\s*/, "");
  const expected = compared("expected");
  const actual = compared("actual");
  if (expected !== undefined && actual !== undefined) {
    return `: ${cell(`expected ${expected}, got ${actual}`.slice(0, 160))}`;
  }
  // Otherwise the first line that says something: Go's reports open with the
  // test's own name and a timestamped log line.
  const message = lines
    .find((line) => line !== "" && !/^(=== RUN|\d{4}\/\d\d\/\d\d )/.test(line))
    ?.slice(0, 160);
  return message ? `: ${cell(message)}` : "";
}
