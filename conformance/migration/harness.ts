/**
 * The migration packs' conformance suite, as every pack's test reads it.
 *
 * `scenarios.json` says, once and in no language, what a migration must do
 * in each situation. Each language keeps a fixture per scenario under
 * `<language>/scenarios/<id>/`, written the way a consumer of an SDK in that
 * language would write it, and a pack's test runs every scenario through
 * the pack and hands what came back to `expectConformance`. What counts as
 * a rewrite, a flag or nothing is decided here, in one place, so no pack is
 * held to a looser reading of the same scenario than another.
 *
 * A fixture says what it expects in its own files: a golden copy beside each
 * file an `edit` scenario rewrites (`main.ts.golden`), and a `<- flag`
 * comment on each line a `flag` scenario shows to a person. The comment is
 * the language's own, so the fixture stays a file that language reads.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Change } from "@invariant-app/ir";
import { expect } from "vitest";

export type Language = "typescript" | "python" | "go";

export const LANGUAGES: readonly Language[] = ["typescript", "python", "go"];

/** What a migration must do in a scenario. */
export type Outcome = "edit" | "flag" | "none";

/** What a pack did, which may be both at once. */
export type Observed = Outcome | "edit+flag";

/** A pack not yet doing what a scenario asks, and what it does instead. */
export interface Gap {
  observed: Observed;
  reason: string;
}

export interface Scenario {
  id: string;
  group: string;
  /** The semantic situation, in one sentence and no language. */
  situation: string;
  /** Ids of the Changes the scenario applies, from the manifest's catalogue. */
  changes: string[];
  /**
   * Which of the SDK's styles the fixture uses: the hand-written SDK, the
   * types a generator emits from the contract, or a hand-written SDK that
   * spells its fields its own way.
   */
  sdk: "handwritten" | "generated" | "own-names";
  expect: Outcome;
  /** For `flag`: where the site is, as the fixture's marks place it. */
  place?: string;
  gaps?: Partial<Record<Language, Gap>>;
}

export interface Manifest {
  about: string;
  contract: Record<string, string>;
  changes: Change[];
  scenarios: Scenario[];
}

export const ROOT = import.meta.dirname;

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(ROOT, "scenarios.json"), "utf8")) as Manifest;
}

/** The Changes a scenario applies, in the order it lists them. */
export function changesOf(manifest: Manifest, scenario: Scenario): Change[] {
  return scenario.changes.map((id) => {
    const change = manifest.changes.find((each) => each.id === id);
    if (!change)
      throw new Error(`${scenario.id} applies ${id}, which is not in the manifest`);
    return change;
  });
}

/** The extension of each language's sources. */
const EXTENSIONS: Record<Language, string> = {
  typescript: ".ts",
  python: ".py",
  go: ".go",
};

/** A line a `flag` scenario expects shown: `// <- flag` or `# <- flag`. */
const MARK = /(?:\/\/|#) <- flag\b/;

export interface Fixture {
  language: Language;
  scenario: Scenario;
  dir: string;
  /** Every source file of the scenario, absolute. */
  files: string[];
  original: Map<string, string>;
  /** The text each rewritten file must end up as. */
  golden: Map<string, string>;
  /** The 1-based lines each file expects shown to a person. */
  marked: Map<string, number[]>;
}

export function scenarioDir(language: Language, id: string): string {
  return join(ROOT, language, "scenarios", id);
}

/**
 * A scenario's fixture in one language, checked for what its outcome needs:
 * a golden for a rewrite, marks for a flag, and neither for nothing.
 */
export function loadFixture(language: Language, scenario: Scenario): Fixture {
  const dir = scenarioDir(language, scenario.id);
  if (!existsSync(dir)) throw new Error(`${language} has no fixture for ${scenario.id}`);
  // Recursively, since a Go scenario over two packages is two directories.
  const names = readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
  const files = names
    .filter((name) => name.endsWith(EXTENSIONS[language]))
    .map((name) => join(dir, name));
  if (files.length === 0) throw new Error(`${dir} holds no ${EXTENSIONS[language]} file`);
  const original = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
  const golden = new Map<string, string>();
  for (const name of names.filter((each) => each.endsWith(".golden"))) {
    const file = join(dir, name.slice(0, -".golden".length));
    if (!original.has(file))
      throw new Error(`${name} is the golden of no source in ${dir}`);
    golden.set(file, readFileSync(join(dir, name), "utf8"));
  }
  const marked = new Map<string, number[]>();
  for (const [file, text] of original) {
    const lines = text
      .split("\n")
      .flatMap((line, index) => (MARK.test(line) ? [index + 1] : []));
    if (lines.length > 0) marked.set(file, lines);
  }
  const fixture = { language, scenario, dir, files, original, golden, marked };
  const wrong =
    scenario.expect === "edit"
      ? golden.size === 0
        ? "an edit scenario needs a golden file"
        : marked.size > 0
          ? "an edit scenario marks no flags"
          : undefined
      : scenario.expect === "flag"
        ? marked.size === 0
          ? "a flag scenario needs a line marked `<- flag`"
          : golden.size > 0
            ? "a flag scenario has no golden file"
            : undefined
        : golden.size > 0 || marked.size > 0
          ? "a none scenario has neither a golden file nor marks"
          : undefined;
  if (wrong) throw new Error(`${language} ${scenario.id}: ${wrong}`);
  return fixture;
}

/** What a pack's run returned, in the terms every pack shares. */
export interface Run {
  /** New contents per file, where the pack changed any. */
  files: ReadonlyMap<string, string>;
  manual: readonly { file: string; line: number; reason?: string }[];
}

export interface Verdict {
  observed: Observed;
  /** Whether the pack did exactly what the scenario asks. */
  meets: boolean;
  /** Each fixture file as the pack left it, for a readable failure. */
  after: Map<string, string>;
  /** The lines shown to a person in each fixture file. */
  flagged: Map<string, number[]>;
}

/**
 * What a pack did with a scenario, and whether it is what the scenario
 * asks. Only the fixture's own files count: a pack that reaches into the
 * SDK or anywhere else is caught by its own tests, not here.
 */
export function judge(fixture: Fixture, run: Run): Verdict {
  const after = new Map(
    fixture.files.map((file) => [
      file,
      run.files.get(file) ?? (fixture.original.get(file) as string),
    ]),
  );
  const flagged = new Map<string, number[]>();
  for (const site of run.manual) {
    if (!fixture.original.has(site.file)) continue;
    const lines = flagged.get(site.file) ?? [];
    if (!lines.includes(site.line)) lines.push(site.line);
    flagged.set(site.file, lines);
  }
  for (const lines of flagged.values()) lines.sort((a, b) => a - b);
  const edited = fixture.files.some(
    (file) => after.get(file) !== fixture.original.get(file),
  );
  const shown = flagged.size > 0;
  const observed: Observed =
    edited && shown ? "edit+flag" : edited ? "edit" : shown ? "flag" : "none";
  const same = (a: Map<string, number[]>, b: Map<string, number[]>) =>
    a.size === b.size &&
    [...a].every(([file, lines]) => (b.get(file) ?? []).join(",") === lines.join(","));
  const meets =
    observed === fixture.scenario.expect &&
    (observed !== "edit" ||
      fixture.files.every(
        (file) =>
          after.get(file) ===
          (fixture.golden.get(file) ?? (fixture.original.get(file) as string)),
      )) &&
    (observed !== "flag" || same(flagged, fixture.marked));
  return { observed, meets, after, flagged };
}

/**
 * Asserts a pack's run of a scenario: exactly what the scenario asks, or,
 * where the manifest records a gap in this language, still that gap. A gap
 * that closes, or fails differently, fails here until the manifest says so.
 *
 * With `INVARIANT_CONFORMANCE_REPORT` naming a file, each verdict is also
 * appended to it as a line of JSON, which is how a pack's author sees what
 * it does across every scenario at once.
 */
export function expectConformance(fixture: Fixture, run: Run): void {
  const { language, scenario } = fixture;
  const verdict = judge(fixture, run);
  const gap = scenario.gaps?.[language];
  const report = process.env["INVARIANT_CONFORMANCE_REPORT"];
  if (report) {
    const relative = (file: string) => file.slice(fixture.dir.length + 1);
    appendFileSync(
      report,
      `${JSON.stringify({
        language,
        id: scenario.id,
        expect: scenario.expect,
        observed: verdict.observed,
        meets: verdict.meets,
        gap: gap?.observed,
        flagged: run.manual
          .filter((site) => fixture.original.has(site.file))
          .map((site) => `${relative(site.file)}:${site.line} ${site.reason ?? ""}`),
        after: Object.fromEntries(
          [...verdict.after]
            .filter(([file, text]) => text !== fixture.original.get(file))
            .map(([file, text]) => [relative(file), text]),
        ),
      })}\n`,
    );
  }
  if (gap) {
    expect({ meets: verdict.meets, observed: verdict.observed }).toEqual({
      meets: false,
      observed: gap.observed,
    });
    return;
  }
  expect(verdict.observed).toBe(scenario.expect);
  if (scenario.expect === "edit") {
    expect(Object.fromEntries(verdict.after)).toEqual(
      Object.fromEntries(
        fixture.files.map((file) => [
          file,
          fixture.golden.get(file) ?? fixture.original.get(file),
        ]),
      ),
    );
  }
  if (scenario.expect === "flag") {
    expect(Object.fromEntries(verdict.flagged)).toEqual(
      Object.fromEntries(fixture.marked),
    );
  }
  expect(verdict.meets).toBe(true);
}
