/**
 * `invariant doctor`, `invariant contract export`, and `invariant verify
 * --rebuild`, against throwaway copies of the fixture provider.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateSigningKey } from "@invariant/bundle";
import { oasdiffAvailable } from "@invariant/diff";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { doctor, renderDoctor } from "./doctor.ts";
import { rebuildAt, release, verifyRelease } from "./release.ts";

const run = promisify(execFile);
const MAIN = new URL("./main.ts", import.meta.url).pathname;
const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const hasOasdiff = await oasdiffAvailable();

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function copyProvider(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-doctor-"));
  for (const entry of ["invariant.yaml", "invariant", "openapi"]) {
    await cp(join(FIXTURE, entry), join(scratch, entry), { recursive: true });
  }
  return scratch;
}

async function commitAll(root: string, message: string): Promise<string> {
  const git = (args: string[]) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: root,
    });
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", message]);
  return (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

describe.skipIf(!hasOasdiff)("invariant doctor", () => {
  it("finds nothing wrong with a provider whose program matches its Changes", async () => {
    const root = await copyProvider();
    const findings = await doctor(await loadConfig(join(root, "invariant.yaml")));
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(renderDoctor(findings)).toContain(
      "invariant/compiled/program.json matches the Changes",
    );
  });

  it("catches a program nobody recompiled after the Changes moved on", async () => {
    // The dangerous one: the program ships in the build, so a stale one
    // serves old callers a translation the gate never checked. Here it is the
    // program as compiled before any of the pending Changes were written.
    const root = await copyProvider();
    const program = join(root, "invariant/compiled/program.json");
    const compiled = JSON.parse(await readFile(program, "utf8"));
    compiled.contracts["2026-03-01"].sites = {};
    await writeFile(program, JSON.stringify(compiled), "utf8");

    const findings = await doctor(await loadConfig(join(root, "invariant.yaml")));
    const rendered = renderDoctor(findings);
    expect(rendered).toContain("is not what the Changes compile to now");
    expect(rendered).toContain("invariant compile");
  });
});

describe("invariant contract export", () => {
  it("writes the specification of the contract named", async () => {
    const root = await copyProvider();
    const { stdout } = await run(
      process.execPath,
      [MAIN, "contract", "export", "--label", "2026-03-01"],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    expect(stdout).toBe(await readFile(join(root, "openapi/2026-03-01.json"), "utf8"));
  });

  it("names the contracts that exist when asked for one that does not", async () => {
    const root = await copyProvider();
    const failure = await run(
      process.execPath,
      [MAIN, "contract", "export", "--label", "1999"],
      {
        cwd: root,
      },
    ).catch((error: { stderr: string }) => error);
    expect((failure as { stderr: string }).stderr).toContain("2026-01-15, 2026-03-01");
  });
});

describe.skipIf(!hasOasdiff)("invariant verify --rebuild", () => {
  it("rebuilds a published bundle from the commit it names, identically", async () => {
    const root = await copyProvider();
    await run("git", ["init", "-q"], { cwd: root });
    const commit = await commitAll(root, "the release");

    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const config = await loadConfig(join(root, "invariant.yaml"));
    const result = await release(config, {
      signingKeyPem: privateKeyPem,
      source: { repo: "acme/payments-api", commit },
    });
    await commitAll(root, "record the release");

    const opened = await verifyRelease(
      join(root, "invariant/bundles", `${result.label}.dsse.json`),
      [publicKeyPem],
      (bundle) => rebuildAt(root, config.path, bundle),
    );
    expect(opened.reproduced).toBe(true);
  });

  it("refuses a bundle released from changes that were never committed", async () => {
    const root = await copyProvider();
    await run("git", ["init", "-q"], { cwd: root });
    const commit = await commitAll(root, "the release");

    // Released from a working tree with an edit the commit does not have.
    const path = join(root, "invariant/changes/chg_payment_status_vocabulary.yaml");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        "Payment status became paid / failed / processing.",
        "Payment status was renamed.",
      ),
      "utf8",
    );
    const { privateKeyPem, publicKeyPem } = generateSigningKey();
    const config = await loadConfig(join(root, "invariant.yaml"));
    const result = await release(config, {
      signingKeyPem: privateKeyPem,
      source: { repo: "acme/payments-api", commit },
    });

    await expect(
      verifyRelease(
        join(root, "invariant/bundles", `${result.label}.dsse.json`),
        [publicKeyPem],
        (bundle) => rebuildAt(root, config.path, bundle),
      ),
    ).rejects.toThrow(/does not match a rebuild from source. Differs in: changes/);
  });
});
