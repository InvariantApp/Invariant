/**
 * Retiring an endpoint, through the path a provider actually takes.
 *
 * The runtime's retired-endpoint refusal was tested against a program written
 * by hand, and the compiler's chaining step threw the retired list away. So the
 * op compiled, the gate passed, and an old caller of a retired endpoint was
 * served by whatever still answered at that path. Nothing here is written by
 * hand: the Change goes through `invariant check`, and the program it produces
 * is the one the provider's build ships.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, loadConfig, renderComment, renderReport } from "@invariant/cli";
import { oasdiffAvailable } from "@invariant/diff";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT, type RunningProvider, startProvider } from "./harness.ts";

const PROVIDER = join(REPO_ROOT, "fixtures/provider-acme");
const hasOasdiff = await oasdiffAvailable();

let provider: RunningProvider | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** The fixture provider, with refunds gone from the release being built. */
async function providerRetiringRefunds(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-retire-"));
  for (const entry of ["invariant.yaml", "invariant", "openapi"]) {
    await cp(join(PROVIDER, entry), join(scratch, entry), { recursive: true });
  }

  const head = join(scratch, "openapi/head.json");
  const document = JSON.parse(await readFile(head, "utf8"));
  delete document.paths["/v1/refunds"];
  await writeFile(head, JSON.stringify(document, null, 2), "utf8");

  await writeFile(
    join(scratch, "invariant/changes/chg_refunds_retired.yaml"),
    `irVersion: 1
id: chg_refunds_retired
summary: Refunds are issued from the dashboard, not the API.
ops:
  - op: retire
    endpoint: { method: post, path: /v1/refunds }
    guidance: Issue refunds from the dashboard instead.
    refuse: true
assertions:
  same_concept: true
  side_effects_unchanged: true
`,
    "utf8",
  );
  return scratch;
}

describe.skipIf(!hasOasdiff)("an endpoint retired in a release", () => {
  it("is refused with the provider's guidance by the program the gate compiles", async () => {
    const root = await providerRetiringRefunds();
    const report = await check(await loadConfig(join(root, "invariant.yaml")));
    expect(report.result, report.warnings.join("\n")).not.toBe("block");

    provider = await startProvider({ program: report.program });
    const response = await fetch(`${provider.baseUrl}/v1/refunds`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test_alpha",
        "acme-version": "2026-03-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payment: "pay_1", amount_cents: 100 }),
    });

    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invariant_endpoint_retired");
    expect(body.error.message).toContain("Issue refunds from the dashboard instead.");
  });

  it("is refused by the gate while someone is still on an older contract", async () => {
    const root = await providerRetiringRefunds();
    // The fixture's own policy is `unmigratableWithActiveConsumers: block`.
    const recent = Math.floor(Date.now() / 1000) - 3600;
    await writeFile(
      join(root, "invariant/usage.jsonl"),
      `${JSON.stringify({
        consumer: "a1b2c3d4e5f60718",
        contract: "2026-03-01",
        changeId: "chg_refund_targets_payment",
        count: 12,
        lastSeen: recent,
      })}\n`,
      "utf8",
    );

    const report = await check(await loadConfig(join(root, "invariant.yaml")));
    expect(report.result).toBe("block");
    expect(report.program).toBeUndefined();
    const rendered = renderReport(report);
    expect(rendered).toContain("Refused by the gate settings in invariant.yaml");
    expect(rendered).toContain("chg_refunds_retired");
    expect(renderComment(report)).toContain(
      "### Refused by this repository's gate settings",
    );
  });
});
