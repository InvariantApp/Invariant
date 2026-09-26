/**
 * Where the evidence a rewrite rests on stops short, the site is shown and
 * not edited: a field inherited from a base other types share, read from a
 * value that is only the base; request parameters gathered in an object
 * that is also read on its own; an untyped parameter one caller passes
 * something else to.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Change } from "@invariant-app/ir";
import { buildPlan } from "@invariant-app/migrate-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "../../../conformance/migration/harness.ts";
import { migrate } from "./index.ts";

const SDK = join(ROOT, "typescript", "sdk");

const renamed = (id: string, schema: string, from: string, to: string): Change => ({
  irVersion: 1,
  id,
  summary: `\`${from}\` is now \`${to}\`.`,
  scopes: [{ schema: `#/components/schemas/${schema}` }],
  ops: [{ op: "move", from: `/${from}`, to: `/${to}` }],
});

const types = {
  customer: "Customer",
  customer_create_params: "CustomerCreateParams",
};

describe("a rewrite whose evidence stops short", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "invariant-evidence-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (name: string, lines: string[], changes: Change[]) => {
    const file = join(dir, name);
    await writeFile(file, lines.join("\n"));
    const result = await migrate({
      repoDir: dir,
      generated: [`${SDK}/`],
      sources: [file],
      resolution: { baseUrl: SDK, paths: { acme: ["index.d.ts"], "acme/*": ["*"] } },
      plan: buildPlan(changes, {
        package: "acme",
        upgradeTo: { package: "acme", version: "2.0.0", types },
        types,
        accessors: [],
      }),
    });
    return { after: result.files.get(file), manual: result.manual };
  };

  it("shows an inherited field read from a value that is only the base", async () => {
    const { after, manual } = await run(
      "base.ts",
      [
        'import type { Customer, CustomerBase } from "acme";',
        "",
        "export function emails(customer: Customer, base: CustomerBase): string[] {",
        "  return [customer.email, base.email];",
        "}",
        "",
      ],
      [renamed("chg_email", "customer", "email", "email_address")],
    );
    expect(after).toContain("return [customer.email_address, base.email];");
    expect(manual.map((site) => [site.line, site.reason.split(";")[0]])).toEqual([
      [
        4,
        "`email` is declared on a base that `Customer` shares, and this value is not certainly a `Customer`",
      ],
    ]);
  });

  it("shows gathered parameters that are also read on their own", async () => {
    const { after, manual } = await run(
      "gathered.ts",
      [
        'import Acme from "acme";',
        "",
        'const client = new Acme("sk_test");',
        "",
        "export function signUp(name: string) {",
        "  const params = { nickname: name };",
        "  console.log(params.nickname);",
        "  return client.customers.create(params);",
        "}",
        "",
      ],
      [
        renamed(
          "chg_params_nickname",
          "customer_create_params",
          "nickname",
          "display_name",
        ),
      ],
    );
    expect(after).toBeUndefined();
    expect(manual.map((site) => site.line)).toEqual([6]);
  });

  it("shows a read through an untyped parameter one caller passes something else", async () => {
    const { after, manual } = await run(
      "untyped.ts",
      [
        'import Acme from "acme";',
        "",
        'const client = new Acme("sk_test");',
        "",
        "// biome-ignore lint/suspicious/noExplicitAny: as the consumer wrote it",
        "function label(customer: any): string {",
        "  return customer.nickname;",
        "}",
        "",
        "export async function show(id: string): Promise<string[]> {",
        '  return [label(await client.customers.retrieve(id)), label({ nickname: "x" })];',
        "}",
        "",
      ],
      [renamed("chg_nickname", "customer", "nickname", "display_name")],
    );
    expect(after).toBeUndefined();
    expect(manual.map((site) => site.line)).toContain(7);
  });
});
