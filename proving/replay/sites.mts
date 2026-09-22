/**
 * Rig E, the denominator: every place a human edited source on a bump's pull
 * request.
 *
 * The miner found the pull requests; this reads what the humans did on each.
 * A bot's commit touches manifests and lockfiles, so every hunk in a source
 * file is a human's: a call site fixed, a type renamed, an import moved. Each
 * hunk is one site the migration engine is later scored on, as found, missed,
 * or edited differently.
 *
 * Only where and how much is kept: the file, the lines the hunk spans on each
 * side, and how many it added and removed. The code stays in its repository,
 * as the index promises, and is read again from there when a case is
 * replayed.
 *
 * Usage:
 *   GITHUB_TOKEN=... node --import tsx proving/replay/sites.mts [--limit 100]
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT } from "../corpus/manifest.mts";
import type { ReplayCase, ReplayIndex } from "./mine.mts";

/** The languages L8 counts apart. npm cases are TypeScript or JavaScript by what the humans edited. */
export type Language = "typescript" | "javascript" | "python" | "go";

export interface Hunk {
  file: string;
  /** A test the humans fixed, which is migration work too, counted apart. */
  test: boolean;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  added: number;
  removed: number;
}

export interface CaseSites {
  id: string;
  language: Language;
  sites: Hunk[];
  /** GitHub leaves out a file's patch past a size; such a file is listed, not counted. */
  withoutPatch: string[];
}

export interface SitesFile {
  about: string;
  cases: CaseSites[];
}

const TYPESCRIPT = /\.(ts|tsx|mts|cts)$/;
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go)$/;
const TEST =
  /(^|\/)(tests?|__tests__|spec)\/|[._](test|spec)\.[a-z]+$|_test\.go$|(^|\/)test_[^/]*\.py$/;

/** The hunks of one file's unified diff, as GitHub returns it in a pull request's files. */
export function hunksOf(file: string, patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        file,
        test: TEST.test(file),
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        added: 0,
        removed: 0,
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  return hunks;
}

/**
 * The language a case is counted under. An npm case is TypeScript when the
 * humans edited any TypeScript, since the engine then works from its types;
 * plain JavaScript is the harder case L8 counts separately.
 */
export function languageOf(entry: Pick<ReplayCase, "ecosystem" | "files">): Language {
  if (entry.ecosystem === "pypi") return "python";
  if (entry.ecosystem === "go") return "go";
  return entry.files.some((file) => TYPESCRIPT.test(file)) ? "typescript" : "javascript";
}

const TOKEN = process.env["GITHUB_TOKEN"] ?? "";

async function github<T>(path: string, attempt = 0): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "invariant-proving",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (response.status >= 500 && attempt < 3) {
    await sleep(2_000 * (attempt + 1));
    return github(path, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} for ${path}`);
  return (await response.json()) as T;
}

const INDEX = join(ROOT, "proving/replay/index.json");
const SITES = join(ROOT, "proving/replay/sites.json");

async function readSites(): Promise<SitesFile> {
  try {
    return JSON.parse(await readFile(SITES, "utf8")) as SitesFile;
  } catch {
    return {
      about:
        "Rig E. Where humans edited source on each indexed pull request: one hunk is one site the migration engine is scored on. Positions and sizes only; the code stays in its repositories.",
      cases: [],
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--limit");
  const limit = at === -1 ? Number.POSITIVE_INFINITY : Number(args[at + 1]);
  const index = JSON.parse(await readFile(INDEX, "utf8")) as ReplayIndex;
  const file = await readSites();
  const done = new Set(file.cases.map((entry) => entry.id));
  let read = 0;
  try {
    for (const entry of index.cases) {
      if (done.has(entry.id)) continue;
      if (read >= limit) break;
      const files = await github<{ filename: string; patch?: string }[]>(
        `/repos/${entry.repo}/pulls/${entry.pr}/files?per_page=100`,
      );
      const sources = files.filter((each) => SOURCE.test(each.filename));
      file.cases.push({
        id: entry.id,
        language: languageOf(entry),
        sites: sources.flatMap((each) =>
          each.patch === undefined ? [] : hunksOf(each.filename, each.patch),
        ),
        withoutPatch: sources
          .filter((each) => each.patch === undefined)
          .map((each) => each.filename),
      });
      read += 1;
    }
  } finally {
    file.cases.sort((a, b) => a.id.localeCompare(b.id));
    await writeFile(SITES, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
  const byLanguage = new Map<Language, { cases: number; sites: number }>();
  for (const entry of file.cases) {
    const count = byLanguage.get(entry.language) ?? { cases: 0, sites: 0 };
    count.cases += 1;
    count.sites += entry.sites.filter((site) => !site.test).length;
    byLanguage.set(entry.language, count);
  }
  process.stdout.write(
    `${read} cases read; ${[...byLanguage]
      .map(
        ([language, count]) => `${language} ${count.cases} cases, ${count.sites} sites`,
      )
      .join("; ")}\n`,
  );
}

if (process.argv[1]?.endsWith("sites.mts")) await main();
