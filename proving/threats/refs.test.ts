/**
 * A specification that points somewhere else: server-side request forgery and
 * file disclosure through `$ref`.
 *
 * A specification is input. It arrives in a pull request, in a snapshot, in a
 * document posted to the service, and whatever reads it must never be made to
 * fetch a URL or open a file outside the repository it sits in. Each test
 * writes a real repository with a hostile document and runs the verb a
 * provider runs on it, with a server listening where the document points, so
 * "never fetched" is asserted as "nothing arrived there".
 */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bundleDocument,
  ContractError,
  contractOf,
  loadContract,
  standaloneText,
} from "@invariant-app/contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invariant, recordingUpstream, type Upstream, workdir } from "./harness.ts";

let listener: Upstream;
let outside: string;
/** Text in a file outside every repository, which must never be read into one. */
const CANARY = `canary-${process.pid}-${Date.now()}`;

beforeAll(async () => {
  listener = await recordingUpstream(() => ({
    headers: { "content-type": "application/yaml" },
    body: "type: string\n",
  }));
  outside = await workdir("outside");
  await writeFile(join(outside, "secret.yaml"), `description: ${CANARY}\ntype: string\n`);
});

afterAll(async () => {
  await listener?.close();
  await rm(outside, { recursive: true, force: true });
});

beforeEach(() => {
  listener.seen.length = 0;
});

/** An OpenAPI document whose one response schema is `schema`. */
function document(schema: unknown): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "threats", version: "1" },
    paths: {
      "/v1/items": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema } },
            },
          },
        },
      },
    },
  });
}

/** A provider repository with `head` as the current document and a clean baseline. */
async function repository(
  head: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const root = await workdir("refs");
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "openapi"), { recursive: true });
  await writeFile(join(root, "openapi/head.json"), head);
  await writeFile(join(root, "openapi/base.json"), document({ type: "string" }));
  for (const [path, text] of Object.entries(extra)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await writeFile(
    join(root, "invariant.yaml"),
    [
      "api: threats",
      "spec:",
      "  current: openapi/head.json",
      "  released:",
      '    "2026-01-01": openapi/base.json',
      "identity:",
      "  - kind: default",
      '    label: "2026-01-01"',
      "",
    ].join("\n"),
  );
  return root;
}

const hostile = (): [string, () => string, RegExp][] => [
  ["an http URL", () => `${listener.url}/schema.yaml`, /never fetched/],
  [
    "an https URL",
    () => `https://127.0.0.1:${new URL(listener.url).port}/s.yaml`,
    /never fetched/,
  ],
  [
    "a scheme-relative URL",
    () => `//127.0.0.1:${new URL(listener.url).port}/schema.yaml`,
    /outside the repository/,
  ],
  ["a file URL", () => "file:///etc/passwd", /never fetched/],
  [
    "a path that climbs out of the repository",
    () => "../../../../../../../../etc/passwd",
    /outside the repository/,
  ],
  ["an absolute path", () => join(outside, "secret.yaml"), /outside the repository/],
];

describe("invariant check on a specification with a hostile $ref", () => {
  it.each(hostile())("refuses %s and fetches nothing", async (_name, target, message) => {
    const root = await repository(document({ $ref: target() }));
    try {
      const result = await invariant(["check", "--config", join(root, "invariant.yaml")]);
      expect(result.code).toBe(1);
      expect(result.output).toMatch(message);
      expect(result.output).not.toContain(CANARY);
      expect(listener.seen).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses one hidden in a file the document refers to", async () => {
    const root = await repository(document({ $ref: "./schemas/item.json" }), {
      "openapi/schemas/item.json": JSON.stringify({
        $ref: `${listener.url}/deeper.yaml`,
      }),
    });
    try {
      const result = await invariant(["check", "--config", join(root, "invariant.yaml")]);
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/never fetched/);
      expect(listener.seen).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a link committed beside the specification that points outside the repository", async () => {
    // `relative()` judged the name, which is inside; the file it opens is not.
    // Before the fix this read the canary into the document.
    const root = await repository(document({ $ref: "./schemas/item.yaml" }));
    await mkdir(join(root, "openapi/schemas"));
    await symlink(join(outside, "secret.yaml"), join(root, "openapi/schemas/item.yaml"));
    try {
      const result = await invariant(["check", "--config", join(root, "invariant.yaml")]);
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/outside the repository/);
      expect(result.output).not.toContain(CANARY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses one in a released baseline, which is read the same way", async () => {
    const root = await repository(document({ type: "string" }));
    await writeFile(
      join(root, "openapi/base.json"),
      document({ $ref: `${listener.url}/b.yaml` }),
    );
    try {
      const result = await invariant(["check", "--config", join(root, "invariant.yaml")]);
      expect(result.code).toBe(1);
      expect(listener.seen).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("every other way a specification is read", () => {
  it.each(hostile())(
    "a document that arrives over the network refuses %s outright",
    (_name, target) => {
      expect(() =>
        contractOf("posted", JSON.parse(document({ $ref: target() }))),
      ).toThrow(/External \$ref is not allowed/);
      expect(listener.seen).toEqual([]);
    },
  );

  it.each(hostile())(
    "loading, bundling and snapshotting a file refuse %s",
    async (_name, target) => {
      const root = await repository(document({ $ref: target() }));
      try {
        const path = join(root, "openapi/head.json");
        await expect(loadContract(path, "head")).rejects.toBeInstanceOf(ContractError);
        await expect(bundleDocument(path)).rejects.toThrow();
        await expect(standaloneText(path)).rejects.toThrow();
        expect(listener.seen).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("a Swagger 2.0 document is converted without following its references out", async () => {
    const swagger = JSON.stringify({
      swagger: "2.0",
      info: { title: "threats", version: "1" },
      paths: {
        "/v1/items": {
          get: {
            responses: {
              "200": { description: "ok", schema: { $ref: `${listener.url}/s.json` } },
            },
          },
        },
      },
    });
    const root = await repository(swagger);
    try {
      await expect(loadContract(join(root, "openapi/head.json"), "head")).rejects.toThrow(
        /never fetched/,
      );
      expect(listener.seen).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invariant init reads a hostile specification without fetching", async () => {
    const root = await workdir("init");
    try {
      await mkdir(join(root, ".git"));
      await writeFile(
        join(root, "openapi.json"),
        document({ $ref: `${listener.url}/s.yaml` }),
      );
      const result = await invariant(["init", "--spec", "openapi.json", "--no-ci"], {
        cwd: root,
      });
      expect(result.code).toBe(1);
      expect(listener.seen).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
