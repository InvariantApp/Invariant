/**
 * The provider's build step.
 *
 * Compiles every historical contract still in service into one program and
 * writes it into the build. The program ships with the code it belongs to, so
 * the adapter and the API deploy together and roll back together.
 */
import { writeFile } from "node:fs/promises";
import { type ContractStep, chainProgram } from "@invariant/compiler";
import { loadContract, loadPendingChanges, loadReleaseStep } from "@invariant/contract";

const ROOT = new URL("..", import.meta.url).pathname;

async function main(): Promise<void> {
  const [v1, v2, head] = await Promise.all([
    loadContract(`${ROOT}openapi/2026-01-15.json`, "2026-01-15"),
    loadContract(`${ROOT}openapi/2026-03-01.json`, "2026-03-01"),
    loadContract(`${ROOT}openapi/head.json`, "2026-09-20"),
  ]);

  const steps: ContractStep[] = [
    {
      label: "2026-03-01",
      parent: "2026-01-15",
      from: v1.document,
      to: v2.document,
      changes: (await loadReleaseStep(`${ROOT}invariant`, "2026-03-01")).changes,
    },
    {
      label: "2026-09-20",
      parent: "2026-03-01",
      from: v2.document,
      to: head.document,
      changes: await loadPendingChanges(`${ROOT}invariant`),
    },
  ];

  const { program, issues } = chainProgram(
    "acme-payments",
    "2026-09-20",
    head.digest,
    steps,
  );
  if (issues.length > 0) {
    for (const issue of issues) console.error(`${issue.changeId}: ${issue.message}`);
    process.exit(1);
  }

  const out = `${ROOT}invariant/compiled/program.json`;
  await writeFile(out, `${JSON.stringify(program, null, 2)}\n`);
  console.log(`wrote ${out}`);
  for (const [label, contract] of Object.entries(program.contracts)) {
    console.log(
      `  ${label}: ${contract.routes.length} routes, ${Object.keys(contract.sites).length} sites`,
    );
  }
}

await main();
