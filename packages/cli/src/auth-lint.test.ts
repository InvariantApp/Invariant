import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flagsInAuthCode } from "./auth-lint.ts";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function repo(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "invariant-auth-lint-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text, "utf8");
  }
  return root;
}

const FLAG = "chg_contact_name_split";

describe("behavior flags in authentication and authorization code", () => {
  it("finds one in a file whose path says it is auth code, in any binding's language", async () => {
    const dir = await repo({
      "src/middleware/auth.ts": `export const skip = (c) => before(inv, c, "${FLAG}");\n`,
      "internal/authz/check.go": `if inv.Before("${FLAG}", contract) {\n\treturn nil\n}\n`,
    });
    const found = await flagsInAuthCode(dir, [FLAG]);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(
      /^internal\/authz\/check\.go:1: behavior flag chg_contact_name_split/,
    );
    expect(found[1]).toMatch(
      /^src\/middleware\/auth\.ts:1: .*authentication or authorization code/,
    );
  });

  it("finds one deciding access in an ordinary handler", async () => {
    const dir = await repo({
      "src/contacts.ts": [
        'app.delete("/v1/contacts/:id", async (c) => {',
        `  if (!c.get("user").isAdmin && !before(inv, c, "${FLAG}")) {`,
        '    return c.json({ error: "forbidden" }, 403);',
        "  }",
        "});",
      ].join("\n"),
    });
    expect(await flagsInAuthCode(dir, [FLAG])).toEqual([
      expect.stringMatching(
        /^src\/contacts\.ts:2: .*who a caller is or what they may do.*never from the contract it speaks\.$/,
      ),
    ]);
  });

  it("leaves a branch on the shape of data alone, and code that is not the provider's", async () => {
    const dir = await repo({
      "src/contacts.ts": [
        'app.post("/v1/contacts", async (c) => {',
        "  const body = await c.req.json();",
        `  const contact = before(inv, c, "${FLAG}")`,
        "    ? splitName(body.name)",
        "    : { first_name: body.first_name, last_name: body.last_name };",
        "});",
      ].join("\n"),
      "node_modules/some-auth/index.js": `before(inv, c, "${FLAG}");\n`,
      "dist/auth.js": `before(inv, c, "${FLAG}");\n`,
      "src/auth.ts": 'export const unrelated = "chg_other_flag";\n',
    });
    expect(await flagsInAuthCode(dir, [FLAG])).toEqual([]);
    expect(await flagsInAuthCode(dir, [])).toEqual([]);
  });
});
