/**
 * Retroactive onboarding, proven on Qdrant (M5.7).
 *
 * Qdrant 1.19 deleted the search endpoints; 1.18 still serves them, and query
 * answers the same question in a new envelope. A provider in that position
 * wants to switch 1.18 off without breaking whoever still searches. This runs
 * the whole flow the way that provider would:
 *
 * 1. The repository as `invariant init` left it at 1.19 (qdrant/invariant.yaml).
 * 2. `invariant history import v1.18.0=<1.18's document>`: 1.18 goes in front
 *    of the chain, and the Changes to 1.19 are drafted with rules only.
 * 3. The drafts are answered: the ones Rig D's review kept are kept, and the
 *    draft retiring search is replaced by qdrant/changes/, which routes a
 *    search to query and moves its answer out of result.points.
 * 4. 1.18 is started as the deployment still serving search, and
 *    `invariant check --full` asks it and 1.19 behind the proxy the same
 *    things (qdrant/scenarios/), with 1.18 as the oracle through a `url`
 *    source.
 *
 *   node --import tsx proving/retro/qdrant.mts [--record]
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  check,
  importHistory,
  loadConfig,
  renderReport,
  reportJson,
} from "@invariant-app/cli";

const HERE = join(import.meta.dirname, "qdrant");
const ROOT = join(import.meta.dirname, "../..");
const WORK = join(ROOT, ".cache/retro/qdrant");
const REVIEWED = join(ROOT, "proving/servers/changes/qdrant/v1.18.0..v1.19.0");
const REPLACED = "chg_retired_post_collections_collection_name_points_search";
const ORACLE = "invariant-retro-oracle";

const log = (line: string) => process.stderr.write(`${line}\n`);

const manifest = JSON.parse(
  await readFile(join(ROOT, "proving/servers/projects.json"), "utf8"),
) as {
  projects: {
    name: string;
    repo: string;
    image: string;
    spec: { path: string };
    releases: Record<string, { commit: string; digest: string }>;
  }[];
};
const qdrant = manifest.projects.find((project) => project.name === "qdrant");
if (!qdrant) throw new Error("projects.json has no qdrant");

await rm(WORK, { recursive: true, force: true });
await mkdir(join(WORK, "specs"), { recursive: true });
await cp(join(HERE, "invariant.yaml"), join(WORK, "invariant.yaml"));
await cp(join(HERE, "scenarios"), join(WORK, "invariant/scenarios"), { recursive: true });
for (const tag of ["v1.18.0", "v1.19.0"]) {
  const { commit } = qdrant.releases[tag] as { commit: string };
  const url = `https://raw.githubusercontent.com/${qdrant.repo}/${commit}/${qdrant.spec.path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  await writeFile(join(WORK, "specs", `${tag}.json`), await response.text(), "utf8");
}

// 2. History.
log("invariant history import v1.18.0=specs/v1.18.0.json");
const imported = await importHistory(await loadConfig(join(WORK, "invariant.yaml")), [
  { label: "v1.18.0", spec: join(WORK, "specs/v1.18.0.json") },
]);
const drafted = (imported.steps[0]?.drafts ?? []).map((draft) => draft.id).sort();

// 3. The drafts, answered.
const step = join(WORK, "invariant/released/v1.19.0");
await rm(step, { recursive: true, force: true });
await mkdir(step, { recursive: true });
const answered: string[] = [];
for (const [dir, skip] of [
  [REVIEWED, REPLACED],
  [join(HERE, "changes"), ""],
] as const) {
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith(".yaml") || name === `${skip}.yaml`) continue;
    await cp(join(dir, name), join(step, name));
    answered.push(name.replace(/\.yaml$/, ""));
  }
}
// Quoted, as `release` writes it: a label can look like something else.
await writeFile(
  join(step, "order.yaml"),
  [
    'contract: "v1.19.0"',
    'parent: "v1.18.0"',
    "changes:",
    ...answered.map((id) => `  - "${id}"`),
    "",
  ].join("\n"),
  "utf8",
);

// 4. The old version, still deployed, and the full check against it.
const release = qdrant.releases["v1.18.0"] as { digest: string };
spawnSync("docker", ["rm", "-f", ORACLE], { stdio: "ignore" });
const started = spawnSync(
  "docker",
  [
    "run",
    "-d",
    "--rm",
    "--name",
    ORACLE,
    "-p",
    "127.0.0.1:16333:6333",
    `${qdrant.image}:v1.18.0@${release.digest}`,
  ],
  { encoding: "utf8" },
);
if (started.status !== 0) throw new Error(`starting 1.18 failed: ${started.stderr}`);
let report: Awaited<ReturnType<typeof check>>;
try {
  log("invariant check --full");
  report = await check(await loadConfig(join(WORK, "invariant.yaml")), { full: true });
} finally {
  spawnSync("docker", ["rm", "-f", ORACLE], { stdio: "ignore" });
}
await writeFile(join(WORK, "gate.txt"), `${renderReport(report)}\n`, "utf8");
await writeFile(join(WORK, "gate.json"), reportJson(report), "utf8");

const e6 = report.evidence.filter((entry) => entry.kind === "E6-differential");
const result = {
  flow: "history import v1.18.0, drafts answered, check --full against the running 1.18",
  drafted: drafted.length,
  keptAsDrafted: drafted.filter((id) => answered.includes(id)).length,
  // Drafts the reviewed answers did without, the search retirement among them.
  notKept: drafted.filter((id) => !answered.includes(id)),
  writtenByHand: answered.filter((id) => !drafted.includes(id)),
  closure: {
    result: report.evidence.find(
      (entry) => entry.kind === "E2-closure" && entry.subject === "v1.18.0 -> v1.19.0",
    )?.result,
    unexplained: report.steps[0]?.unexplained ?? [],
    issues: report.steps[0]?.issues ?? [],
  },
  differential: e6.map((entry) => ({
    subject: entry.subject,
    result: entry.result,
    summary: entry.summary,
    detail: entry.detail ?? [],
  })),
  problems: report.problems,
  result: report.result,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (process.argv.includes("--record")) {
  await writeFile(
    join(HERE, "results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}
