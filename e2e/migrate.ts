/**
 * Producing a migrated copy of a consumer, so the demo can run it.
 *
 * The copy lives beside the original rather than replacing it, because the
 * unmigrated consumer is still the evidence for step 2: the same source has to
 * keep working through the adapter and work again once migrated.
 */
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadPendingChanges, loadReleaseStep } from "@invariant/contract";
import { buildPlan, migrate, type SymbolMap } from "@invariant/migrate-ts";
import { REPO_ROOT } from "./harness.ts";

const PROVIDER = join(REPO_ROOT, "fixtures/provider-acme");

/**
 * How the SDK built for contract 2026-01-15 names what that contract describes.
 * Both contract steps' schema names appear, because the Changes being applied
 * span both and each names its own step's schemas.
 */
export const CONSUMER_A_SYMBOLS: SymbolMap = {
  package: "@acme/sdk-v1",
  upgradeTo: { package: "@acme/sdk-v3", version: "workspace:*" },
  types: {
    Charge: "Charge",
    ChargeCreateParams: "ChargeCreateParams",
    Payment: "Charge",
    PaymentCreateParams: "ChargeCreateParams",
    Refund: "Refund",
    RefundCreateParams: "RefundCreateParams",
  },
  accessors: [{ from: ["charges"], to: ["payments"] }],
  helpers: { toMinor: "toMinorUnits", fromMinor: "fromMinorUnits" },
};

export interface MigratedConsumer {
  dir: string;
  changedFiles: string[];
  manual: { file: string; line: number; reason: string }[];
  newDiagnostics: string[];
}

export async function migrateConsumerA(): Promise<MigratedConsumer> {
  const consumer = join(REPO_ROOT, "fixtures/consumer-a-sdk-v1");
  const out = join(consumer, ".migrated");

  const released = await loadReleaseStep(join(PROVIDER, "invariant"), "2026-03-01");
  const pending = await loadPendingChanges(join(PROVIDER, "invariant"));

  const result = await migrate({
    repoDir: consumer,
    sdkDir: join(REPO_ROOT, "fixtures/sdk-acme-v1"),
    tsConfigFilePath: join(consumer, "tsconfig.json"),
    plan: buildPlan([...released.changes, ...pending], CONSUMER_A_SYMBOLS),
  });

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "src"), { recursive: true });
  for (const entry of await readdir(join(consumer, "src"))) {
    await cp(join(consumer, "src", entry), join(out, "src", entry));
  }
  for (const [file, text] of result.files) {
    await writeFile(join(out, relative(consumer, file)), text, "utf8");
  }
  await writeFile(
    join(out, "package.json"),
    `${JSON.stringify(
      {
        name: "@fixtures/consumer-a-migrated",
        private: true,
        type: "module",
        dependencies: { "@acme/sdk-v3": "workspace:*" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    dir: out,
    changedFiles: [...result.files.keys()].map((file) => relative(consumer, file)).sort(),
    manual: result.manual.map((site) => ({
      file: relative(consumer, site.file),
      line: site.line,
      reason: site.reason,
    })),
    newDiagnostics: result.diagnosticsAfter.filter(
      (diagnostic) => !result.diagnosticsBefore.includes(diagnostic),
    ),
  };
}
