#!/usr/bin/env node
import { existsSync } from "node:fs";
/**
 * The `invariant` command.
 *
 * Two verbs so far. `check` is the release gate, run on every pull request that
 * touches the API. `compile` writes the program into the build, where it ships
 * with the code it belongs to.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ControlPlaneError } from "@invariant/client";
import { loadContract } from "@invariant/contract";
import { scenariosFromDocument, scenarioYaml } from "@invariant/verifier";
import { check, renderReport, reportJson } from "./check.ts";
import { renderComment } from "./comment.ts";
import { loadConfig } from "./config.ts";
import { doctor, renderDoctor } from "./doctor.ts";
import { type InitOptions, init, renderInit } from "./init.ts";
import { renderProposals, runPropose } from "./propose.ts";
import { rebuildAt, release, renderRelease, verifyRelease } from "./release.ts";
import { assessRetirement, renderRetirement, retireContracts } from "./retire.ts";
import { upsertReviewComment } from "./review.ts";
import {
  clientFromEnv,
  publishBundles,
  renderPublished,
  renderStatus,
  ServiceError,
  status,
} from "./service.ts";
import { readLedger } from "./usage.ts";
import { watchChecks } from "./watch.ts";

const USAGE = `invariant <command>

  init      Set up this repository: find the specification, snapshot it as the
            baseline, and write invariant.yaml and a CI workflow.
  check     Does this release's declared Changes explain what the API did?
            With --full, also starts both builds and compares what they do.
  propose   Draft Change files for whatever this release has not explained.
  compile   Write the compiled program into the build.
  release   Mint the contract, move the Changes, and sign the evolution bundle.
  verify    Open a published bundle and check who signed it. With --rebuild,
            also rebuild it from the commit it names and compare.
  publish [label]
            Send the signed releases in invariant/bundles to the service.
            Safe to run again: a release it already has is not sent twice.
  status    What production is using: each contract, and who is still on it.
  retire    Say which old contracts nobody is using any more.
  doctor    Check the toolchain, the configuration, every contract, and that
            the compiled program is what the Changes compile to now.
  contract export --label <c> [--out <path>]
            Write one contract's specification, for configuring a gateway.
  scenarios generate [--label <c>]
            Write the scenarios check --full would make from each released
            contract's document into invariant/scenarios, to keep and edit.

Options
  --spec <path>     init: the OpenAPI document, when there is more than one
  --spec-command <c> init: a command that writes it, for generated specifications
  --spec-out <path> init: where that command writes it
  --api <name>      init: the API's name (default: the document's title)
  --label <label>   init: the baseline contract's name (default: today)
  --header <name>   init: the header callers name a contract in
  --no-ci           init: do not write a GitHub Actions workflow
  --force           init: replace an existing invariant.yaml
  --config <path>   Path to invariant.yaml (default: ./invariant.yaml)
  --out <path>      Where compile writes (default: invariant/compiled/program.json)
  --full            check: also start the real builds and compare them
  --outcomes <path> check: what the deployed runtime reported, for E9
  --usage <path>    check, retire: the usage ledger the runtime's counters wrote
  --format <f>      check: markdown for a pull request comment, json for a machine
  --watch           check: check again whenever a file under the configuration changes
  --comment         check: write the report on the GitLab merge request or
                    Bitbucket pull request this pipeline is for
  --write           propose: write the drafts into invariant/changes
  --offline         propose: deterministic rules only, no model calls
  --context <text>  propose: notes about this release, weighed as evidence
  --dry-run         release: say what would happen and write nothing
  --repo <name>     release: the repository this release came from
  --commit <sha>    release: the commit this release came from
  --pr <number>     release: the pull request it was merged in
  --key <path>      verify: a trusted ed25519 public key, in PEM form
  --days <n>        retire: how long a contract must be quiet (default 30);
                    status: how far back to count (default 30)
  --write           retire: remove the retired contracts from invariant.yaml

Environment
  INVARIANT_SIGNING_KEY   release: the ed25519 private key, in PEM form
  INVARIANT_TOKEN         publish, status: a token from the dashboard
  INVARIANT_URL           publish, status: the service, if not the hosted one
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

  if (command === "init") {
    const options: InitOptions = {
      root: process.cwd(),
      ci: argv.includes("--no-ci") ? "none" : "github",
      force: argv.includes("--force"),
    };
    for (const [name, key] of [
      ["spec", "spec"],
      ["spec-command", "specCommand"],
      ["spec-out", "specOut"],
      ["api", "api"],
      ["label", "label"],
      ["header", "header"],
    ] as const) {
      const value = flag(argv, name);
      if (value !== undefined) options[key] = value;
    }
    const result = await init(options);
    process.stdout.write(`${renderInit(result)}\n`);

    // The first check, run straight away, so the provider sees the gate work
    // before committing anything: against a baseline that is the same
    // document, it has to pass.
    const report = await check(await loadConfig(result.configPath));
    process.stdout.write(`\nFirst check: ${report.result.toUpperCase()}\n`);
    return report.result === "block" ? 1 : 0;
  }

  const configPath = resolve(flag(argv, "config") ?? "invariant.yaml");

  if (command === "check") {
    const format = flag(argv, "format") ?? "text";
    if (!["text", "markdown", "json"].includes(format)) {
      throw new Error(`--format must be text, markdown or json, not ${format}`);
    }
    const outcomes = flag(argv, "outcomes");
    const usage = flag(argv, "usage");
    const once = async (): Promise<number> => {
      // Read again each time, so a watch sees an edited invariant.yaml too.
      const report = await check(await loadConfig(configPath), {
        full: argv.includes("--full"),
        ...(outcomes === undefined ? {} : { outcomes }),
        ...(usage === undefined ? {} : { usage }),
      });
      process.stdout.write(
        format === "markdown"
          ? renderComment(report)
          : format === "json"
            ? reportJson(report)
            : `${renderReport(report)}\n`,
      );
      if (argv.includes("--comment")) {
        // Never changes the verdict: a comment that could not be written is
        // said so, and the exit code still decides.
        const outcome = await upsertReviewComment(renderComment(report));
        process.stderr.write(
          outcome.host === undefined
            ? `no comment written: ${outcome.reason}\n`
            : outcome.comment === "not-permitted"
              ? `no comment written: the ${outcome.host} token may not write on this review\n`
              : `${outcome.comment} the ${outcome.host} comment\n`,
        );
      }
      return report.result === "block" ? 1 : 0;
    };
    if (!argv.includes("--watch")) return once();
    return watchChecks(dirname(configPath), once);
  }

  const config = await loadConfig(configPath);

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

  if (command === "release") {
    const dryRun = argv.includes("--dry-run");
    const pr = flag(argv, "pr");
    const signingKeyPem = process.env["INVARIANT_SIGNING_KEY"];

    const result = await release(config, {
      dryRun,
      full: argv.includes("--full"),
      ...(signingKeyPem ? { signingKeyPem } : {}),
      source: {
        repo: flag(argv, "repo") ?? "unknown",
        commit: flag(argv, "commit") ?? "unknown",
        ...(pr === undefined ? {} : { pr: Number(pr) }),
      },
    });

    process.stdout.write(`${renderRelease(result, dryRun)}\n`);
    return 0;
  }

  if (command === "verify") {
    const envelope = argv[1];
    if (!envelope) {
      process.stderr.write("verify needs the path to a bundle\n");
      return 1;
    }

    const keys = await Promise.all(
      argv
        .flatMap((entry, index) => (entry === "--key" ? [argv[index + 1] as string] : []))
        .map((path) => readFile(resolve(path), "utf8")),
    );
    if (keys.length === 0) {
      process.stderr.write(
        "verify needs at least one --key, or it cannot tell you anything\n",
      );
      return 1;
    }

    const opened = await verifyRelease(
      resolve(envelope),
      keys,
      argv.includes("--rebuild")
        ? (bundle) => rebuildAt(config.root, config.path, bundle)
        : undefined,
    );
    process.stdout.write(
      [
        `${opened.bundle.api} ${opened.bundle.from.label} -> ${opened.bundle.to.label}`,
        `  signed by  ${opened.keyid}`,
        `  digest     ${opened.digest}`,
        `  changes    ${opened.bundle.changes.map((change) => change.id).join(", ")}`,
        `  evidence   ${opened.bundle.evidence.length} records`,
        `  source     ${opened.bundle.source.repo}@${opened.bundle.source.commit}`,
        `  rebuilt    ${opened.reproduced ? "identical, from the commit it names" : "not checked; pass --rebuild"}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (command === "publish" || command === "status") {
    try {
      const { client, url } = clientFromEnv(process.env);
      if (command === "publish") {
        const published = await publishBundles(
          config,
          client,
          argv[1]?.startsWith("--") ? undefined : argv[1],
        );
        process.stdout.write(renderPublished(published, url));
      } else {
        const days = flag(argv, "days");
        process.stdout.write(
          renderStatus(await status(client, days === undefined ? 30 : Number(days))),
        );
      }
      return 0;
    } catch (error) {
      if (error instanceof ServiceError || error instanceof ControlPlaneError) {
        process.stderr.write(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }

  if (command === "retire") {
    const ledger = flag(argv, "usage") ?? "invariant/usage.jsonl";
    const days = flag(argv, "days");
    const report = assessRetirement(
      config,
      await readLedger(resolve(config.root, ledger)),
      days === undefined ? {} : { windowDays: Number(days) },
    );

    process.stdout.write(`${renderRetirement(report)}\n`);

    if (argv.includes("--write") && report.retirable.length > 0) {
      const { removed } = await retireContracts(
        resolve(flag(argv, "config") ?? "invariant.yaml"),
        report.retirable,
      );
      process.stdout.write(
        `\nStopped serving ${removed.join(", ")}. Run "invariant compile" and commit both.\n`,
      );
    }
    return 0;
  }

  if (command === "doctor") {
    const findings = await doctor(config);
    process.stdout.write(`${renderDoctor(findings)}\n`);
    return findings.some((finding) => finding.severity === "error") ? 1 : 0;
  }

  if (command === "contract" && argv[1] === "export") {
    const label = flag(argv, "label");
    if (!label) {
      process.stderr.write("contract export needs --label <contract>\n");
      return 1;
    }
    const path =
      label === (config.currentLabel ?? "current")
        ? config.currentSpec
        : config.releasedSpecs.get(label);
    if (!path) {
      const known = [...config.releasedSpecs.keys(), config.currentLabel ?? "current"];
      process.stderr.write(
        `There is no contract called ${label}. This repository has ${known.join(", ")}.\n`,
      );
      return 1;
    }
    const text = await readFile(path, "utf8");
    const out = flag(argv, "out");
    if (out) {
      await writeFile(resolve(out), text, "utf8");
      process.stdout.write(`wrote ${label} to ${resolve(out)}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  if (command === "scenarios" && argv[1] === "generate") {
    const only = flag(argv, "label");
    const labels = only === undefined ? [...config.releasedSpecs.keys()] : [only];
    const directory = join(config.invariantDir, "scenarios");
    await mkdir(directory, { recursive: true });
    for (const label of labels) {
      const specPath = config.releasedSpecs.get(label);
      if (!specPath) {
        process.stderr.write(
          `There is no released contract called ${label}. Released: ${[...config.releasedSpecs.keys()].join(", ")}.\n`,
        );
        return 1;
      }
      const made = scenariosFromDocument(
        (await loadContract(specPath, label)).document,
        label,
        {
          headers: config.scenarios.headers,
        },
      );
      for (const scenario of made.scenarios) {
        const slug = scenario.name
          .replace(/ \(generated\)$/, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        const path = join(directory, `${label}-${slug}.yaml`);
        // A file already there may have been edited, and is the provider's.
        if (existsSync(path)) {
          process.stdout.write(
            `kept ${relative(process.cwd(), path)}, which is already there\n`,
          );
          continue;
        }
        await writeFile(
          path,
          scenarioYaml(
            { ...scenario, name: scenario.name.replace(/ \(generated\)$/, "") },
            `Made by \`invariant scenarios generate\` from contract ${label}'s document.\n` +
              "Yours now: edit the values, add steps, or delete it. It is written in\n" +
              `the shapes of ${label}, because that is the traffic whose meaning has to survive.`,
          ),
          "utf8",
        );
        process.stdout.write(`wrote ${relative(process.cwd(), path)}\n`);
      }
      for (const reason of made.skipped) {
        process.stdout.write(`left out ${label} ${reason}\n`);
      }
    }
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
