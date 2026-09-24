/**
 * Tampered or spoofed contract labels, where the provider's own code reads
 * them: a behavior flag says which contract a caller chose, so it must never
 * decide who the caller is or what they may do (DESIGN 11.1). `invariant
 * check`, run as a provider's CI runs it, refuses a release whose flag is used
 * in authentication or authorization code, and lets the same flag through
 * where it only picks the shape of a request.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invariant, workdir } from "./harness.ts";

const FLAG = "chg_contact_name_split";

function contacts(properties: Record<string, unknown>, required: string[]): string {
  const schema = { $ref: "#/components/schemas/Contact" };
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Contacts", version: "1" },
    paths: {
      "/v1/contacts": {
        post: {
          operationId: "contacts.create",
          requestBody: { required: true, content: { "application/json": { schema } } },
          responses: {
            "201": { description: "ok", content: { "application/json": { schema } } },
          },
        },
      },
    },
    components: { schemas: { Contact: { type: "object", required, properties } } },
  });
}

let root: string;

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text, "utf8");
}

const check = () =>
  invariant(["check", "--config", join(root, "invariant.yaml"), "--format", "json"]);

beforeAll(async () => {
  root = await workdir("flags");
  await put("openapi/old.json", contacts({ name: { type: "string" } }, ["name"]));
  await put(
    "openapi/head.json",
    contacts({ first_name: { type: "string" }, last_name: { type: "string" } }, [
      "first_name",
      "last_name",
    ]),
  );
  await put(
    "invariant.yaml",
    'api: contacts\nspec:\n  current: openapi/head.json\n  currentLabel: "2026-09-20"\n  released:\n    "2026-01-01": openapi/old.json\n',
  );
  // The release's one break, acknowledged by a behavior Change in the exact
  // lines the gate prints for it.
  const first = await check();
  const unexplained = (JSON.parse(first.output) as { steps: { unexplained: string[] }[] })
    .steps[0]?.unexplained as string[];
  await put(
    `invariant/changes/${FLAG}.yaml`,
    `irVersion: 1\nid: ${FLAG}\nsummary: "Contact.name became first_name and last_name."\nassertions:\n  side_effects_unchanged: true\nops:\n  - op: behavior\n    flag: ${FLAG}\n    covers:\n${unexplained.map((line) => `      - ${JSON.stringify(line)}`).join("\n")}\n`,
  );
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("behavior flags used in auth code paths", () => {
  it("are let through where they only pick the shape of a request", async () => {
    await put(
      "src/contacts.ts",
      `app.post("/v1/contacts", async (c) => {\n  const body = await c.req.json();\n  const contact = before(inv, c, "${FLAG}")\n    ? splitName(body.name)\n    : body;\n});\n`,
    );
    const result = await check();
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.output).problems).toEqual([]);
  }, 60_000);

  it.each([
    [
      "in a file that is auth code",
      "src/middleware/auth.ts",
      `export const legacy = (c) => before(inv, c, "${FLAG}");\n`,
    ],
    [
      "deciding access in a handler",
      "src/admin.ts",
      `if (!user.isAdmin && !before(inv, c, "${FLAG}")) {\n  return c.json({ error: "forbidden" }, 403);\n}\n`,
    ],
  ])(
    "block the release %s",
    async (_name, path, text) => {
      await put(path, text);
      try {
        const result = await check();
        expect(result.code, result.output).toBe(1);
        const { problems, result: gate } = JSON.parse(result.output);
        expect(gate).toBe("block");
        expect(problems).toEqual([expect.stringContaining(`${path}:`)]);
        expect(problems[0]).toContain(`behavior flag ${FLAG}`);
      } finally {
        await rm(join(root, path));
      }
    },
    60_000,
  );
});
