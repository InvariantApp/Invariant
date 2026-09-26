import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Change } from "@invariant-app/ir";
import { buildPlan, type SymbolMap } from "@invariant-app/migrate-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "../../../conformance/migration/harness.ts";
import { migrate } from "./index.ts";

/** The conformance suite's SDK, which exports exact conversion helpers. */
const SITE = join(ROOT, "python", "site");

const RESCALED: Change[] = [
  {
    irVersion: 1,
    id: "chg_balance",
    summary: "`balance` is now in minor units.",
    scopes: [{ schema: "#/components/schemas/customer" }],
    ops: [
      {
        op: "convert",
        path: "/balance",
        codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
      },
    ],
  },
  {
    irVersion: 1,
    id: "chg_params_balance",
    summary: "`balance` is now sent in minor units.",
    scopes: [{ schema: "#/components/schemas/customer_create_params" }],
    ops: [
      {
        op: "convert",
        path: "/balance",
        codec: { kind: "scale10", exponent: 2, onInexact: "reject" },
      },
    ],
  },
];

const symbols = (helpers: SymbolMap["helpers"]): SymbolMap => {
  const types = {
    customer: "acme.Customer",
    customer_create_params: "acme.CustomerCreateParams",
  };
  return {
    package: "acme",
    upgradeTo: { package: "acme", version: "2.0.0", types },
    types,
    accessors: [],
    ...(helpers ? { helpers } : {}),
  };
};

const HELPERS = { toMinor: "to_minor_units", fromMinor: "from_minor_units" };

describe("amounts converted with the SDK's helpers", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "invariant-amounts-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (name: string, lines: string[], helpers = HELPERS) => {
    const file = join(dir, name);
    await writeFile(file, lines.join("\n"));
    const result = await migrate({
      repoDir: dir,
      sources: [file],
      packages: [SITE],
      plan: buildPlan(RESCALED, symbols(helpers)),
    });
    return { after: result.files.get(file), manual: result.manual };
  };

  it("adds the helper to the file's own import of the SDK's names", async () => {
    const { after, manual } = await run("named.py", [
      "from decimal import Decimal",
      "",
      "from acme import Client",
      "",
      'client = Client("sk_test")',
      "",
      "",
      "def owed(id: str) -> Decimal:",
      "    return client.customers.retrieve(id).balance",
      "",
    ]);
    expect(manual).toEqual([]);
    expect(after).toBe(
      [
        "from decimal import Decimal",
        "",
        "from acme import Client, from_minor_units",
        "",
        'client = Client("sk_test")',
        "",
        "",
        "def owed(id: str) -> Decimal:",
        "    return from_minor_units(client.customers.retrieve(id).balance)",
        "",
      ].join("\n"),
    );
  }, 60_000);

  it("wraps a literal that is not a whole number of minor units, and passes an amount already in them on", async () => {
    const { after } = await run("inexact.py", [
      "from decimal import Decimal",
      "",
      "import acme",
      "",
      'client = acme.Client("sk_test")',
      "",
      "",
      "def copy(other: acme.Customer) -> None:",
      '    client.customers.create(balance=Decimal("12.505"))',
      "    client.customers.create(balance=other.balance)",
      "",
    ]);
    expect(after).toContain(
      'client.customers.create(balance=acme.to_minor_units(Decimal("12.505")))',
    );
    expect(after).toContain("client.customers.create(balance=other.balance)");
  }, 60_000);

  it("shows every site where the SDK does not export the helpers named", async () => {
    const { after, manual } = await run(
      "missing.py",
      [
        "import acme",
        "",
        "",
        "def owed(customer: acme.Customer) -> object:",
        "    return customer.balance",
        "",
      ],
      { toMinor: "toMinorUnits", fromMinor: "fromMinorUnits" },
    );
    expect(after).toBeUndefined();
    expect(manual.map((site) => [site.line, site.reason])).toEqual([
      [
        5,
        "`balance` is now written as the value times 10^2, which this engine does not rewrite",
      ],
    ]);
  }, 60_000);
});
