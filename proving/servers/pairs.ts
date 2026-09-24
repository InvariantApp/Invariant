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
  /**
   * Tests the release broke by behavior neither release's document
   * describes, as the manifest names them, set aside with the reason. They
   * are left out of `broken`, so a pair whose every break is of this kind is
   * vacuous. Older results carry none.
   */
  behavioral?: { test: string; reason: string }[];
}

/**
 * A test the manifest names as broken by behavior no document describes: an
 * error message reworded, a rule for combining states changed. It is set
 * aside only while it fails as recorded, with `says` in what it said both
 * without the adapter and through it, so it cannot hide a different failure,
 * or one the adapter caused.
 */
export interface Behavioral {
  test: string;
  says: string;
  reason: string;
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

/** Whitespace folded, since a report may wrap what a test said. */
const folded = (text: string) => text.replace(/\s+/g, " ").trim();

export function compareArms(
  arms: {
    a: ArmResult;
    b: ArmResult;
    c: ArmResult;
  },
  behavioral: readonly Behavioral[] = [],
): Pick<
  PairResult,
  "valid" | "broken" | "served" | "regressions" | "volatile" | "behavioral"
> {
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
  const failing = valid.filter((id) => arms.b.outcomes[id] !== "passed");
  // Set aside only where arm c ran, and both it and arm b failed the test
  // saying what the manifest recorded.
  const says = (arm: ArmResult, id: string, entry: Behavioral) =>
    arm.outcomes[id] === "failed" &&
    folded(arm.messages?.[id] ?? "").includes(folded(entry.says));
  const setAside = arms.c.error
    ? []
    : behavioral.filter(
        (entry) =>
          failing.includes(entry.test) &&
          says(arms.b, entry.test, entry) &&
          says(arms.c, entry.test, entry),
      );
  const aside = new Set(setAside.map((entry) => entry.test));
  const broken = failing.filter((id) => !aside.has(id));
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
    ...(setAside.length > 0
      ? {
          behavioral: setAside.map(({ test, reason }) => ({ test, reason })),
        }
      : {}),
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
  /** Tests set aside because the release broke them by behavior no document describes. */
  behavioral: number;
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
    behavioral: results.reduce(
      (sum, result) => sum + (result.behavioral?.length ?? 0),
      0,
    ),
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
      : "") +
    (counts.behavioral > 0
      ? `; ${counted(counts.behavioral, "test")} broken by behavior no document describes, set aside`
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
    "| Project | Release | Changes | Gate | Valid tests | Broken by the release | Served through the adapter | Regressions | Volatile, set aside | Behavioral, set aside | Verdict |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const result of results) {
    const failed = Object.entries(result.arms)
      .filter(([, arm]) => arm.error)
      .map(([name, arm]) => `arm ${name}: ${cell(arm.error ?? "")}`);
    const gate = result.gate;
    const changes = `${result.changes} ${gate.changesFrom}`;
    lines.push(
      `| ${result.project} (${result.language}) | ${result.from} -> ${result.to} | ${changes} | ${gate.result} | ${result.valid} | ${result.broken.length} | ${result.served.length} | ${result.regressions.length}${failed.length ? `; ${failed.join("; ")}` : ""} | ${result.volatile?.length ?? 0} | ${result.behavioral?.length ?? 0} | ${verdict(result)} |`,
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
    const behavioral = result.behavioral ?? [];
    if (
      unserved.length === 0 &&
      result.regressions.length === 0 &&
      gateLines.length === 0 &&
      volatile.length === 0 &&
      behavioral.length === 0
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
    if (behavioral.length > 0) {
      lines.push(
        "Set aside, since the release broke them by behavior neither document describes, and they failed as recorded with the adapter and without it:",
        "",
      );
      for (const { test, reason } of behavioral) {
        lines.push(`- \`${test}\`${said(result.arms.b, test)}. ${cell(reason)}`);
      }
      lines.push("");
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
