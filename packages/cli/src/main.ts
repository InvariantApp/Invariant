#!/usr/bin/env node
/**
 * The `invariant` command.
 *
 * Two verbs so far. `check` is the release gate, run on every pull request that
 * touches the API. `compile` writes the program into the build, where it ships
 * with the code it belongs to.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { check, renderReport } from "./check.ts";
import { loadConfig } from "./config.ts";
import { renderProposals, runPropose } from "./propose.ts";

const USAGE = `invariant <command>

  check     Does this release's declared Changes explain what the API did?
            With --full, also starts both builds and compares what they do.
  propose   Draft Change files for whatever this release has not explained.
  compile   Write the compiled program into the build.

Options
  --config <path>   Path to invariant.yaml (default: ./invariant.yaml)
  --out <path>      Where compile writes (default: invariant/compiled/program.json)
  --full            check: also start the real builds and compare them
  --write           propose: write the drafts into invariant/changes
  --offline         propose: deterministic rules only, no model calls
  --context <text>  propose: notes about this release, weighed as evidence
`;

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const config = await loadConfig(resolve(flag(argv, "config") ?? "invariant.yaml"));

  if (command === "check") {
    const report = await check(config, { full: argv.includes("--full") });
    process.stdout.write(`${renderReport(report)}\n`);
    return report.result === "block" ? 1 : 0;
  }

  if (command === "propose") {
    const context = flag(argv, "context");
    const result = await runPropose(config, {
      write: argv.includes("--write"),
      offline: argv.includes("--offline"),
      ...(context === undefined ? {} : { context }),
    });
    process.stdout.write(`${renderProposals(result)}\n`);
    return 0;
  }

  if (command === "compile") {
    const report = await check(config);
    if (!report.program) {
      process.stderr.write(`${renderReport(report)}\n`);
      // Compiling a program from Changes that do not explain the release would
      // produce an adapter that serves the old contract incorrectly.
      return 1;
    }
    const out = resolve(
      config.root,
      flag(argv, "out") ?? "invariant/compiled/program.json",
    );
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(report.program, null, 2)}\n`, "utf8");
    process.stdout.write(`wrote ${out}\n`);
    for (const [label, contract] of Object.entries(report.program.contracts)) {
      process.stdout.write(
        `  ${label}: ${contract.routes.length} routes, ${Object.keys(contract.sites).length} sites\n`,
      );
    }
    return 0;
  }

  process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
