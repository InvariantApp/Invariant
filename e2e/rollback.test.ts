/**
 * The rollback drill.
 *
 * Two mechanisms exist and they are for different emergencies. The kill switch
 * stops a transform now, without a deploy, and costs the old callers their
 * compatibility. Reverting the deploy takes the adapter back to what it was,
 * and costs nothing, but takes as long as a deploy takes.
 *
 * What makes the second one safe is that the compiled program ships inside the
 * provider's own build. There is nothing to roll back separately and nothing
 * that can be left at a different version than the code it belongs to, so
 * "revert the deploy" restores the adapter exactly. This proves that by digest
 * rather than by argument.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACME_PROGRAM } from "@fixtures/provider-acme";
import { loadConfig } from "@invariant/cli";
import { type ContractStep, chainProgram } from "@invariant/compiler";
import {
  digestOf,
  loadContract,
  loadPendingChanges,
  loadReleaseStep,
} from "@invariant/contract";
import { flagsFrom } from "@invariant/flags";
import type { JsonValue } from "@invariant/ir";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT, type RunningProvider, startProvider } from "./harness.ts";

const PROVIDER = join(REPO_ROOT, "fixtures/provider-acme");

let provider: RunningProvider | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

interface Body {
  amount?: number;
  status?: string;
  error?: { code?: string; message?: string };
}

async function oldCharge(baseUrl: string): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${baseUrl}/v1/charges`, {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test_alpha",
      "acme-version": "2026-01-15",
      "content-type": "application/json",
    },
    body: JSON.stringify({ amount: 49.99, currency: "usd", source: "tok_visa" }),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

/** Recompiles the program from the repository, the way a build does. */
async function compileProgram(): Promise<unknown> {
  const v1 = await loadContract(join(PROVIDER, "openapi/2026-01-15.json"), "2026-01-15");
  const v2 = await loadContract(join(PROVIDER, "openapi/2026-03-01.json"), "2026-03-01");
  // The provider's own name for the contract being built, as invariant.yaml
  // declares it. Reading it from anywhere else would make this test agree with
  // a build nobody runs.
  const head = await loadContract(join(PROVIDER, "openapi/head.json"), "2026-09-20");
  const invariant = join(PROVIDER, "invariant");

  const steps: ContractStep[] = [
    {
      label: "2026-03-01",
      parent: "2026-01-15",
      from: v1.document,
      to: v2.document,
      changes: (await loadReleaseStep(invariant, "2026-03-01")).changes,
    },
    {
      label: "head",
      parent: "2026-03-01",
      from: v2.document,
      to: head.document,
      changes: await loadPendingChanges(invariant),
    },
  ];

  // How a request names its contract, from invariant.yaml, as compile reads it.
  const { identity } = await loadConfig(join(PROVIDER, "invariant.yaml"));
  return chainProgram(
    "acme-payments",
    head.label,
    head.digest,
    steps,
    identity ? { identity } : {},
  ).program;
}

describe("rolling back", () => {
  /**
   * The adapter cannot drift from the code it belongs to, because it is part
   * of it. Recompiling from the same repository has to produce the same
   * program the build is already serving, or "revert the deploy" would be
   * restoring something other than what was there.
   */
  it("ships a program that is exactly what the repository compiles to", async () => {
    const committed = JSON.parse(
      await readFile(join(PROVIDER, "invariant/compiled/program.json"), "utf8"),
    ) as JsonValue;

    expect(digestOf((await compileProgram()) as JsonValue)).toBe(digestOf(committed));
  });

  it("restores the previous behaviour exactly when the deploy is reverted", async () => {
    // Before: the current build, serving an old caller through the adapter.
    provider = await startProvider({ build: "head", program: ACME_PROGRAM });
    const before = await oldCharge(provider.baseUrl);
    expect(before.status).toBe(201);
    expect(before.body.amount).toBe(49.99);
    await provider.close();

    // The revert: the previous build is the previous artifact, program and all.
    provider = await startProvider({ build: "2026-01-15" });
    const reverted = await oldCharge(provider.baseUrl);

    // Identical observable behaviour for this caller, which is the point. The
    // old build served this contract natively and the new one served it
    // through a transform, and neither the caller nor its tests can tell.
    expect(reverted.status).toBe(before.status);
    expect(reverted.body.amount).toBe(before.body.amount);
    expect(reverted.body.status).toBe(before.body.status);
  });

  it("switches compatibility off from a file, and back on, without a restart", async () => {
    scratch = await mkdtemp(join(tmpdir(), "invariant-drill-"));
    const path = join(scratch, "flags.json");

    const source = flagsFrom({ path, ttlMs: 0 });
    provider = await startProvider({
      build: "head",
      program: ACME_PROGRAM,
      flags: source.read,
    });

    expect((await oldCharge(provider.baseUrl)).status).toBe(201);

    // The incident: one Change is found to be wrong and is switched off.
    await writeFile(
      path,
      JSON.stringify({ disabledChanges: ["chg_money_in_minor_units"] }),
    );
    const during = await oldCharge(provider.baseUrl);
    expect(during.status).toBe(400);
    expect(during.body.error?.code).toBe("invariant_contract_unsupported");
    // Refused, not quietly served in the canonical shape. An old caller
    // receiving `amount_cents` under a name its contract never had would be a
    // silent corruption, which is worse than an error it can retry.
    expect(during.body.amount).toBeUndefined();

    // The all-clear, in the same process.
    await writeFile(path, JSON.stringify({}));
    const after = await oldCharge(provider.baseUrl);
    expect(after.status).toBe(201);
    expect(after.body.amount).toBe(49.99);
  });

  it("keeps serving when the flags file is corrupted mid-incident", async () => {
    scratch = await mkdtemp(join(tmpdir(), "invariant-drill-"));
    const path = join(scratch, "flags.json");
    await writeFile(path, JSON.stringify({}));

    const source = flagsFrom({ path, ttlMs: 0 });
    provider = await startProvider({
      build: "head",
      program: ACME_PROGRAM,
      flags: source.read,
    });

    expect((await oldCharge(provider.baseUrl)).status).toBe(201);

    // Somebody edits the file under pressure and leaves it malformed. The
    // request path must not care.
    await writeFile(path, "{ disabledChanges: [");
    expect((await oldCharge(provider.baseUrl)).status).toBe(201);
  });
});
