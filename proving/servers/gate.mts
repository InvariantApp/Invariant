/**
 * `invariant check --full` on each Rig D project, from the configuration a
 * stranger would write (M5's exit).
 *
 * `proving/servers/gate/<project>/` holds only what such a provider would
 * commit to make the full check run: `invariant.yaml` and, where the service
 * needs a database, the Compose file that starts it. What their repository
 * would already hold is put beside it here: the two releases' documents, from
 * the commit or release asset projects.json pins, or served by the release
 * itself, started the way the configuration says to start it; and the
 * Changes committed for the release under changes/<project>/<from>..<to>/.
 * Then the check runs, exactly as `invariant check --full` would.
 *
 *   node --import tsx proving/servers/gate.mts [project ...] [--record]
 *
 * `--record` writes what each run found into proving/servers/gate/results.json.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CheckReport,
  check,
  launchBuild,
  loadConfig,
  renderReport,
  reportJson,
} from "@invariant-app/cli";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "../..");
const CACHE = join(ROOT, ".cache/servers");
const RESULTS = join(HERE, "gate/results.json");

interface Project {
  name: string;
  repo: string;
  spec: { path: string } | { asset: string } | { served: string };
  releases: Record<string, { commit: string; specSha256?: string }>;
}

export interface GateRun {
  project: string;
  from: string;
  to: string;
  result: CheckReport["result"] | "error";
  seconds: number;
  /** Differential records, by result. */
  differential: { pass: number; fail: number; skipped: number };
  /** The differential's own summaries, the first few, as the report says them. */
  summaries: string[];
  /** What blocked, the first few of each. */
  unexplained: string[];
  problems: string[];
  error?: string;
}

const log = (line: string) => process.stderr.write(`${line}\n`);

async function fetchSpec(
  project: Project,
  label: string,
  dest: string,
  serve: () => Promise<{
    fetch(request: Request): Promise<Response>;
    close(): Promise<void>;
  }>,
  headers: Record<string, string>,
): Promise<void> {
  const release = project.releases[label];
  if (!release) throw new Error(`${project.name} pins no release ${label}`);
  let body: Buffer;
  if ("path" in project.spec) {
    const url = `https://raw.githubusercontent.com/${project.repo}/${release.commit}/${project.spec.path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    body = Buffer.from(await response.arrayBuffer());
  } else if ("asset" in project.spec) {
    const url = `https://github.com/${project.repo}/releases/download/${label}/${project.spec.asset}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    body = Buffer.from(await response.arrayBuffer());
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== release.specSha256) {
      throw new Error(
        `${url} has SHA-256 ${actual}, not the pinned ${release.specSha256}`,
      );
    }
  } else {
    // The release serves its own document, so it is started the way the
    // configuration starts it and asked.
    const target = await serve();
    try {
      const response = await target.fetch(
        new Request(`http://gate${project.spec.served}`, { headers }),
      );
      if (!response.ok) {
        throw new Error(`${project.spec.served} answered ${response.status}`);
      }
      body = Buffer.from(await response.arrayBuffer());
    } finally {
      await target.close();
    }
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, body);
}

async function gate(project: Project): Promise<GateRun> {
  const started = Date.now();
  const work = join(CACHE, project.name, "gate");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await cp(join(HERE, "gate", project.name), work, { recursive: true });

  const configPath = join(work, "invariant.yaml");
  const config = await loadConfig(configPath);
  const [from, ...more] = [...config.releasedSpecs.keys()];
  const to = config.currentLabel;
  if (!from || more.length > 0 || !to || !config.build) {
    throw new Error(
      `${project.name}: the gate configuration names one released contract, a current label and a build`,
    );
  }
  const run: GateRun = {
    project: project.name,
    from,
    to,
    result: "error",
    seconds: 0,
    differential: { pass: 0, fail: 0, skipped: 0 },
    summaries: [],
    unexplained: [],
    problems: [],
  };

  try {
    const build = { ...config.build, proxy: false };
    for (const [label, dest, as] of [
      [from, config.releasedSpecs.get(from) as string, from],
      [to, config.currentSpec, "head"],
    ] as const) {
      log(`${project.name}: the ${label} document`);
      await fetchSpec(
        project,
        label,
        dest,
        () => launchBuild(as, { build, cwd: work }),
        config.scenarios.headers,
      );
    }

    const recorded = join(HERE, "changes", project.name, `${from}..${to}`);
    await mkdir(join(work, "invariant", "changes"), { recursive: true });
    if (existsSync(recorded)) {
      for (const name of await readdir(recorded)) {
        if (!/\.ya?ml$/.test(name)) continue;
        await cp(join(recorded, name), join(work, "invariant", "changes", name));
      }
    }

    log(`${project.name}: invariant check --full`);
    const report = await check(await loadConfig(configPath), { full: true });
    await writeFile(join(work, "gate.txt"), `${renderReport(report)}\n`, "utf8");
    await writeFile(join(work, "gate.json"), reportJson(report), "utf8");
    const e6 = report.evidence.filter((entry) => entry.kind === "E6-differential");
    run.result = report.result;
    for (const entry of e6) run.differential[entry.result] += 1;
    run.summaries = e6.slice(0, 5).map((entry) => `${entry.subject}: ${entry.summary}`);
    run.unexplained = report.steps.flatMap((step) => step.unexplained).slice(0, 10);
    run.problems = report.problems.slice(0, 20);
    // A check whose every scenario could not be run did not compare
    // anything, whatever it says: that is the run failing, not a finding.
    const unrun = (entry: (typeof e6)[number]) =>
      (entry.detail ?? []).some((line) => line.includes("could not be run"));
    if (e6.length > 0 && e6.every(unrun)) {
      run.error = "no scenario could be run";
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  }
  run.seconds = Math.round((Date.now() - started) / 1000);
  return run;
}

const args = process.argv.slice(2);
const record = args.includes("--record");
const manifest = JSON.parse(await readFile(join(HERE, "projects.json"), "utf8")) as {
  projects: Project[];
};
const wanted = args.filter((arg) => !arg.startsWith("--"));
const names =
  wanted.length > 0
    ? wanted
    : (await readdir(join(HERE, "gate"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

const runs: GateRun[] = [];
for (const name of names) {
  const project = manifest.projects.find((entry) => entry.name === name);
  if (!project) throw new Error(`projects.json has no project ${name}`);
  const run = await gate(project);
  runs.push(run);
  log(
    `${name} ${run.from} -> ${run.to}: ${run.result} in ${run.seconds}s, differential ` +
      `${run.differential.pass} passed, ${run.differential.fail} failed` +
      (run.error ? ` (${run.error})` : ""),
  );
  await mkdir(CACHE, { recursive: true });
  await writeFile(
    join(CACHE, `gate-${name}.json`),
    `${JSON.stringify(run, null, 2)}\n`,
    "utf8",
  );
}

if (record) {
  const previous = existsSync(RESULTS)
    ? (JSON.parse(await readFile(RESULTS, "utf8")) as { runs: GateRun[] }).runs
    : [];
  const merged = [
    ...previous.filter((entry) => !runs.some((run) => run.project === entry.project)),
    ...runs,
  ].sort((a, b) => a.project.localeCompare(b.project));
  await writeFile(RESULTS, `${JSON.stringify({ runs: merged }, null, 2)}\n`, "utf8");
}

// Ran is what this proves; a block is a finding, an error is not.
process.exitCode = runs.some((run) => run.result === "error") ? 1 : 0;
