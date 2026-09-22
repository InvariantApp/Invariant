/**
 * The whole argument, as one command.
 *
 * `pnpm e2e` proves these things to a test runner. This tells the same story to
 * a person, in order, with the provider's real code and three real consumer
 * applications. Nothing here is narrated that was not just done: every line
 * printed follows a request that was actually made or a suite that was actually
 * run.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACME_PROGRAM } from "@fixtures/provider-acme";
import {
  appendLedger,
  assessRetirement,
  hashConsumer,
  loadConfig,
  readLedger,
  renderRetirement,
} from "@invariant-app/cli";
import type { UsageEvent } from "@invariant-app/runtime";
import {
  REPO_ROOT,
  runConsumerSuite,
  runMigratedSuite,
  startProvider,
} from "./harness.ts";
import { migrateConsumerA } from "./migrate.ts";

const PROVIDER = join(REPO_ROOT, "fixtures/provider-acme");

function heading(step: string, title: string): void {
  process.stdout.write(`\n${"─".repeat(72)}\n${step}  ${title}\n${"─".repeat(72)}\n\n`);
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function result(passed: boolean, text: string): void {
  process.stdout.write(`  ${passed ? "PASS" : "FAIL"}  ${text}\n`);
}

const CONSUMER_CONTRACTS = {
  a: "2026-01-15",
  b: "2026-03-01",
  c: "2026-03-01",
} as const;

async function main(): Promise<number> {
  say("\nInvariant: a provider makes a breaking change and nobody breaks.\n");
  say("Three applications integrate with the same API. Each was written");
  say("against the contract that existed at the time, and none of them are");
  say("going to be touched until step three.");

  // ── Step 1 ────────────────────────────────────────────────────────────
  heading("STEP 1", "The break is real");

  say("The provider ships its new API. No compatibility layer, nothing else");
  say("changed. This is what every consumer sees today.\n");

  let provider = await startProvider({ build: "head" });
  for (const id of ["a", "b", "c"] as const) {
    const run = await runConsumerSuite(id, {
      ACME_BASE_URL: provider.baseUrl,
      ACME_API_KEY: "sk_test_alpha",
    });
    result(
      run.passed,
      `consumer ${id.toUpperCase()} (contract ${CONSUMER_CONTRACTS[id]}) - ` +
        `${run.failed} of ${run.ran ? run.succeeded + run.failed : 0} tests failing`,
    );
  }
  await provider.close();

  say("\nThat is the cost of a breaking change, and the reason most providers");
  say("never make one.");

  // ── Step 2 ────────────────────────────────────────────────────────────
  heading("STEP 2", "The same release, with the compiled program in the build");

  say("The provider's changes were declared in their own pull request and");
  say("reviewed there. The compiler turned those declarations into a program");
  say("that ships inside this build. Same consumers, not one line edited.\n");

  const usage: UsageEvent[] = [];
  provider = await startProvider({
    build: "head",
    program: ACME_PROGRAM,
    onUsage: (event) => usage.push(event),
  });

  for (const id of ["a", "b", "c"] as const) {
    const run = await runConsumerSuite(id, {
      ACME_BASE_URL: provider.baseUrl,
      ACME_API_KEY: "sk_test_alpha",
    });
    result(
      run.passed,
      `consumer ${id.toUpperCase()} (contract ${CONSUMER_CONTRACTS[id]}) - ` +
        `${run.succeeded} tests, unmodified`,
    );
  }

  const contracts = new Set(usage.map((event) => event.contract));
  const changes = new Set(usage.flatMap((event) => [...event.changes.keys()]));
  say(
    `\nTwo historical contracts served at once from one implementation, with` +
      `\n${changes.size} changes applied ${usage.length} times across ${contracts.size} of them.`,
  );
  say("The provider wrote their handlers once, against the API they have now.");

  // ── Step 3 ────────────────────────────────────────────────────────────
  heading("STEP 3", "The connected codebase moves forward");

  const migrated = await migrateConsumerA();
  say("Consumer A is two contracts behind. Its source and its own tests were");
  say("rewritten from the same declarations the adapter was compiled from.\n");

  for (const file of migrated.changedFiles) say(`  edited   ${file}`);
  say(`  ${migrated.newDiagnostics.length} new type errors`);
  for (const site of migrated.manual) {
    say(`\n  left alone  ${site.file}:${site.line}`);
    say(`              ${site.reason}`);
  }

  say("\nRunning its suite against the new API with no adapter at all:\n");
  await provider.close();
  provider = await startProvider({ build: "head" });

  const before = await runMigratedSuite(`${migrated.dir}/src`, {
    ACME_BASE_URL: provider.baseUrl,
    ACME_API_KEY: "sk_test_delta",
  });
  result(
    before.failed === migrated.manual.length,
    `${before.succeeded} passing, ${before.failed} failing - and the engine ` +
      `said it could not do ${migrated.manual.length}`,
  );

  // Standing in for the developer acting on the report the pull request
  // carries. It is one line, at the line number the report gave them.
  const flagged = join(migrated.dir, migrated.manual[0]?.file ?? "");
  await writeFile(
    flagged,
    (await readFile(flagged, "utf8")).replace("succeeded", "paid"),
    "utf8",
  );

  const after = await runMigratedSuite(`${migrated.dir}/src`, {
    ACME_BASE_URL: provider.baseUrl,
    ACME_API_KEY: "sk_test_delta",
  });
  result(after.passed, `${after.succeeded} passing once that one site is dealt with`);
  await provider.close();

  // ── Step 4 ────────────────────────────────────────────────────────────
  heading("STEP 4", "The compatibility layer ends");

  const root = await mkdtemp(join(tmpdir(), "invariant-demo-"));
  for (const entry of ["invariant.yaml", "invariant", "openapi"]) {
    await cp(join(PROVIDER, entry), join(root, entry), { recursive: true });
  }

  const ledger = join(root, "usage.jsonl");
  const now = Math.floor(Date.now() / 1000);
  await appendLedger(
    ledger,
    usage.flatMap((event) =>
      [...event.changes].map(([changeId, count]) => ({
        consumer: hashConsumer(event.consumer ?? "unknown"),
        contract: event.contract,
        changeId,
        count,
        lastSeen: now,
      })),
    ),
  );

  say("Every transform the adapter applied in step 2 was counted, so the");
  say("provider can see who is still relying on each old contract.\n");

  const config = await loadConfig(join(root, "invariant.yaml"));
  say(renderRetirement(assessRetirement(config, await readLedger(ledger), { now })));

  say("\nNinety days later, with those consumers migrated away:\n");
  say(
    renderRetirement(
      assessRetirement(config, await readLedger(ledger), { now: now + 90 * 86_400 }),
    ),
  );

  await rm(root, { recursive: true, force: true });

  say(
    `\n${"─".repeat(72)}\n` +
      "A breaking change was made, deployed, and nothing broke. The connected\n" +
      "codebase received the migration. The old contract has an ending.\n",
  );

  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  return 1;
});
