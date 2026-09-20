/**
 * Producing a migrated copy of a consumer, so the demo can run it.
 *
 * The copy lives beside the original rather than replacing it, because the
 * unmigrated consumer is still the evidence for step 2: the same source has to
 * keep working through the adapter and work again once migrated.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

/**
 * How `openapi-typescript` names what a contract describes.
 *
 * Everything lands under one `components` interface rather than as exported
 * types, so the schemas are reached by a path. Consumer B exists to prove the
 * indexer is not shaped around a single generator: nothing about the engine
 * changes between here and consumer A's hand-written SDK except this map.
 *
 * There is no package to upgrade, because the types are generated into the
 * repository rather than installed. Regenerating them is the equivalent step,
 * and the exact conversion helpers have nowhere to be imported from, so the
 * migration writes them in.
 */
export const CONSUMER_B_SYMBOLS: SymbolMap = {
  package: "./acme-types.ts",
  upgradeTo: { package: "./acme-types.ts", version: "" },
  types: {
    Payment: "components.schemas.Payment",
    PaymentCreateParams: "components.schemas.PaymentCreateParams",
    Refund: "components.schemas.Refund",
    RefundCreateParams: "components.schemas.RefundCreateParams",
  },
  accessors: [],
  helpers: {
    toMinor: "toMinorUnits",
    fromMinor: "fromMinorUnits",
    from: "./invariant-units.ts",
    emit: { path: "src/invariant-units.ts" },
  },
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
    generated: [join(REPO_ROOT, "fixtures/sdk-acme-v1")],
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

/**
 * Migrates consumer B, which holds generated types rather than an SDK.
 *
 * Two things differ from consumer A and neither is in the engine. The types are
 * regenerated from the new contract instead of a package being bumped, because
 * that is what a types-only consumer's dependency actually is. And the exact
 * conversion helpers are written into the repository, because there is no SDK
 * for them to arrive in and inlining the arithmetic at each call site would put
 * a rounding bug in every price.
 */
export async function migrateConsumerB(): Promise<MigratedConsumer> {
  const consumer = join(REPO_ROOT, "fixtures/consumer-b-types-v2");
  const out = join(consumer, ".migrated");

  const pending = await loadPendingChanges(join(PROVIDER, "invariant"));

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "src"), { recursive: true });
  for (const entry of await readdir(join(consumer, "src"))) {
    await cp(join(consumer, "src", entry), join(out, "src", entry));
  }

  // Built from the contract being moved to, and held back until the edits are
  // done. The engine resolves references against the declarations the consumer
  // compiles against today; putting these in first would delete the very
  // properties it anchors on.
  const regenerated = join(out, "acme-types.next.ts");
  await regenerateTypes(join(PROVIDER, "openapi/head.json"), regenerated);
  const nextTypes = await readFile(regenerated, "utf8");
  await rm(regenerated);

  await writeFile(
    join(out, "package.json"),
    `${JSON.stringify(
      {
        name: "@fixtures/consumer-b-migrated",
        private: true,
        type: "module",
        dependencies: { "openapi-fetch": "^0.17.0" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await cp(join(consumer, "tsconfig.json"), join(out, "tsconfig.json"));

  const result = await migrate({
    repoDir: out,
    // The one generated file, named exactly. Naming its directory instead
    // would take the consumer's own code with it.
    generated: [join(out, "src/acme-types.ts")],
    tsConfigFilePath: join(out, "tsconfig.json"),
    plan: buildPlan(pending, CONSUMER_B_SYMBOLS),
    regenerate: [{ path: "src/acme-types.ts", source: nextTypes }],
  });

  for (const [file, text] of result.files) {
    await writeFile(file, text, "utf8");
  }

  return {
    dir: out,
    changedFiles: [...result.files.keys()].map((file) => relative(out, file)).sort(),
    manual: result.manual.map((site) => ({
      file: relative(out, site.file),
      line: site.line,
      reason: site.reason,
    })),
    newDiagnostics: result.diagnosticsAfter.filter(
      (diagnostic) => !result.diagnosticsBefore.includes(diagnostic),
    ),
  };
}

/** Runs the consumer's own generator, the way its package.json does. */
async function regenerateTypes(spec: string, out: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("npx", ["openapi-typescript", spec, "-o", out], {
    cwd: REPO_ROOT,
  });
}
