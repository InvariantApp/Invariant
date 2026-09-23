/**
 * Moving the API version a consumer pins, the edit a Stripe upgrade needs
 * most often: on the bumps humans migrated by hand, most of the Stripe ones
 * changed nothing else.
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan } from "@invariant-app/migrate-core";
import { describe, expect, it } from "vitest";
import { migrate } from "./index.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const CONSUMER = `${ROOT}fixtures/consumer-pinned/`;

async function pinned(label: string) {
  const result = await migrate({
    repoDir: CONSUMER,
    generated: [`${CONSUMER}sdk/`],
    tsConfigFilePath: `${CONSUMER}tsconfig.json`,
    plan: buildPlan([], {
      package: "paysdk",
      upgradeTo: { package: "paysdk", version: "2.0.0" },
      types: {},
      accessors: [],
      pin: { type: "Pay.PayConfig", property: "apiVersion", label },
    }),
  });
  return { result, text: result.files.get(`${CONSUMER}src/clients.ts`) ?? "" };
}

describe("an API version pin", () => {
  it("is moved where it is written, in the file's own quotes", async () => {
    const { text } = await pinned("2024-04-10");
    expect(text).toContain(
      `new Pay("sk_test", { apiVersion: '2024-04-10', timeout: 10 })`,
    );
  });

  it("is moved where a constant holds it, and through a type assertion", async () => {
    const { text } = await pinned("2024-04-10");
    expect(text).toContain(`const API_VERSION = "2024-04-10";`);
    expect(text).toContain(`apiVersion: "2024-04-10" as Pay.LatestApiVersion`);
  });

  it("is moved in the consumer's configuration, where a property passes it on", async () => {
    const { text } = await pinned("2024-04-10");
    expect(text).toContain(`apiVersion: "2024-04-10" as const, timeout: 5`);
    expect(text).toContain(`{ apiVersion: config.pay.apiVersion }`);
    // Passed on destructured and as a shorthand, it is the same one literal.
    expect(text).toContain(`const { apiVersion } = config.pay;`);
    expect(text).toContain(`new Pay("sk_test", { apiVersion })`);
  });

  it("is shown to a person where the source does not hold it", async () => {
    const { result } = await pinned("2024-04-10");
    expect(result.manual).toEqual([
      expect.objectContaining({
        line: 13,
        reason: "the apiVersion here is not written in the source; set it to 2024-04-10",
      }),
    ]);
  });

  it("leaves alone a property of the same name that is not the SDK's", async () => {
    const { text } = await pinned("2024-04-10");
    expect(text).toContain(`export const unrelated = { apiVersion: "2023-10-16" };`);
  });

  it("is moved the same where the consumer's configuration cannot be loaded", async () => {
    const result = await migrate({
      repoDir: CONSUMER,
      generated: [`${CONSUMER}sdk/`],
      // The SDK is not listed: the engine reads it from where `generated` says.
      sources: [`${CONSUMER}src/clients.ts`],
      plan: buildPlan([], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0" },
        types: {},
        accessors: [],
        pin: { type: "Pay.PayConfig", property: "apiVersion", label: "2024-04-10" },
      }),
    });
    expect(result.files.get(`${CONSUMER}src/clients.ts`)).toContain(
      `const API_VERSION = "2024-04-10";`,
    );
  });

  it("leaves every import alone where the package keeps its name", async () => {
    const { result } = await pinned("2024-04-10");
    expect(result.edits.map((edit) => edit.reason)).toEqual(
      Array(4).fill("speaks 2024-04-10, the contract the upgrade is built for"),
    );
  });

  it("is read where the checkout sits under a directory whose name starts with a dot", async () => {
    const dotted = await mkdtemp(join(tmpdir(), "replay-"));
    const repo = join(dotted, ".cache", "consumer");
    await cp(CONSUMER, repo, { recursive: true });
    try {
      const result = await migrate({
        repoDir: `${repo}/`,
        generated: [`${repo}/sdk/`],
        sources: [`${repo}/src/clients.ts`],
        plan: buildPlan([], {
          package: "paysdk",
          upgradeTo: { package: "paysdk", version: "2.0.0" },
          types: {},
          accessors: [],
          pin: { type: "Pay.PayConfig", property: "apiVersion", label: "2024-04-10" },
        }),
      });
      expect(result.files.get(`${repo}/src/clients.ts`)).toContain(
        `const API_VERSION = "2024-04-10";`,
      );
    } finally {
      await rm(dotted, { recursive: true, force: true });
    }
  });

  it("is moved in plain JavaScript too, where the SDK's types reach it through require", async () => {
    const result = await migrate({
      repoDir: CONSUMER,
      generated: [`${CONSUMER}sdk/`],
      sources: [`${CONSUMER}src/legacy.js`],
      plan: buildPlan([], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0" },
        types: {},
        accessors: [],
        pin: { type: "Pay.PayConfig", property: "apiVersion", label: "2024-04-10" },
      }),
    });
    expect(result.files.get(`${CONSUMER}src/legacy.js`)).toContain(
      `new Pay("sk_test", { apiVersion: '2024-04-10' })`,
    );
  });

  it("is left as it is when it already names the label", async () => {
    const { result } = await pinned("2023-10-16");
    expect(result.edits.filter((edit) => edit.reason.startsWith("speaks"))).toEqual([]);
  });
});
