/**
 * Importing the exact conversion helpers however the consumer imports the SDK.
 *
 * An amount now in minor units is read through the SDK's `fromMinorUnits`,
 * and the call is only half the edit: the file has to import it. A consumer
 * that names the SDK's types with `import type`, holds the whole module as a
 * namespace or takes only its default export has no list of values to add
 * the helper to, and each still gets an import that compiles.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Change } from "@invariant-app/ir";
import { buildPlan } from "@invariant-app/migrate-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./index.ts";

const SDK = `export interface Charge {
  id: string;
  amount: number;
}
export declare class Pay {
  constructor(key: string);
  retrieve(id: string): Promise<Charge>;
}
export declare function toMinorUnits(amount: number): number;
export declare function fromMinorUnits(minor: number): number;
export default Pay;
`;

const SOURCES = {
  "types.ts": `import type { Charge } from "paysdk";

export const owed = (charge: Charge): number => charge.amount;
`,
  "namespace.ts": `import * as pay from "paysdk";

export const owed = (charge: pay.Charge): number => charge.amount;
`,
  "default.ts": `import Pay from "paysdk";

const client = new Pay("sk_test");

export const owed = async (id: string): Promise<number> =>
  (await client.retrieve(id)).amount;
`,
};

const rescaled: Change = {
  irVersion: 1,
  id: "chg_amount_minor",
  summary: "`amount` is now in minor units.",
  scopes: [{ schema: "#/components/schemas/charge" }],
  ops: [
    {
      op: "convert",
      path: "/amount",
      codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
    },
  ],
};

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "invariant-helpers-"));
  for (const [path, text] of Object.entries({
    "sdk/index.d.ts": SDK,
    ...Object.fromEntries(
      Object.entries(SOURCES).map(([name, text]) => [`repo/${name}`, text]),
    ),
  })) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the conversion helpers' import", () => {
  it("is added however the SDK is imported, and compiles", async () => {
    const repo = join(dir, "repo");
    const result = await migrate({
      repoDir: repo,
      generated: [join(dir, "sdk")],
      sources: Object.keys(SOURCES).map((name) => join(repo, name)),
      resolution: { baseUrl: join(dir, "sdk"), paths: { paysdk: ["index.d.ts"] } },
      plan: buildPlan([rescaled], {
        package: "paysdk",
        upgradeTo: { package: "paysdk", version: "2.0.0", types: { charge: "Charge" } },
        types: { charge: "Charge" },
        accessors: [],
        helpers: { toMinor: "toMinorUnits", fromMinor: "fromMinorUnits" },
      }),
    });
    const after = (name: string) => result.files.get(join(repo, name));
    // `import type` names types only, so the helper gets an import of its own.
    expect(after("types.ts")).toBe(`import { fromMinorUnits } from "paysdk";
import type { Charge } from "paysdk";

export const owed = (charge: Charge): number => fromMinorUnits(charge.amount);
`);
    // A namespace import has no braces to take it.
    expect(after("namespace.ts")).toBe(`import { fromMinorUnits } from "paysdk";
import * as pay from "paysdk";

export const owed = (charge: pay.Charge): number => fromMinorUnits(charge.amount);
`);
    // The braces follow the default import.
    expect(after("default.ts")).toBe(`import Pay, { fromMinorUnits } from "paysdk";

const client = new Pay("sk_test");

export const owed = async (id: string): Promise<number> =>
  fromMinorUnits((await client.retrieve(id)).amount);
`);
    expect(
      result.diagnosticsAfter.filter(
        (diagnostic) => !result.diagnosticsBefore.includes(diagnostic),
      ),
    ).toEqual([]);
  });
});
