/**
 * `invariant init`, run the way a provider runs it: the real command, in a
 * fresh repository, followed by the check it sets up.
 *
 * Two error messages pointed people at this command before it existed. What
 * matters now is that the first thing a provider types leaves them with a
 * gate that works, and that the second thing, a pull request that breaks
 * something, is caught.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { oasdiffAvailable } from "@invariant/diff";
import { afterEach, describe, expect, it } from "vitest";
import { versionHeader } from "./init.ts";

const run = promisify(execFile);
const MAIN = new URL("./main.ts", import.meta.url).pathname;
const FIXTURE = new URL("../../../fixtures/provider-acme/", import.meta.url).pathname;
const hasOasdiff = await oasdiffAvailable();

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function repository(files: Record<string, string>): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-init-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(scratch, path, ".."), { recursive: true });
    await writeFile(join(scratch, path), text, "utf8");
  }
  await run("git", ["init", "-q"], { cwd: scratch });
  return scratch;
}

async function invariant(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [MAIN, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

const acme = () => readFile(join(FIXTURE, "openapi/head.json"), "utf8");

describe.skipIf(!hasOasdiff)("invariant init", () => {
  it("sets up a repository and runs a first check that passes", async () => {
    const root = await repository({ "api/openapi.json": await acme() });
    const result = await invariant(root, ["init", "--label", "2026-09-01"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("First check: PASS");

    const config = await readFile(join(root, "invariant.yaml"), "utf8");
    expect(config).toContain("current: api/openapi.json");
    expect(config).toContain(`"2026-09-01": invariant/contracts/2026-09-01.openapi.json`);
    expect(
      await readFile(join(root, "invariant/contracts/2026-09-01.openapi.json"), "utf8"),
    ).toBe(await acme());
    expect(
      await readFile(join(root, ".github/workflows/invariant.yml"), "utf8"),
    ).toContain("uses: InvariantApp/Invariant@v0");
  });

  it("then catches the first pull request that breaks something", async () => {
    const root = await repository({ "api/openapi.json": await acme() });
    await invariant(root, ["init", "--label", "2026-09-01", "--no-ci"]);

    const document = JSON.parse(await acme());
    delete document.components.schemas.Payment.properties.currency;
    document.components.schemas.Payment.required =
      document.components.schemas.Payment.required.filter(
        (name: string) => name !== "currency",
      );
    await writeFile(join(root, "api/openapi.json"), JSON.stringify(document), "utf8");

    const check = await invariant(root, ["check"]);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain("Release status: BLOCK");
    expect(check.stdout).toContain("currency");
  });

  it("runs a generator through the shell, redirects and all", async () => {
    const root = await repository({ "spec-source.json": await acme() });
    const result = await invariant(root, [
      "init",
      "--label",
      "2026-09-01",
      "--no-ci",
      "--spec-command",
      "cat spec-source.json > generated.json",
      "--spec-out",
      "generated.json",
    ]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("First check: PASS");
    const config = await readFile(join(root, "invariant.yaml"), "utf8");
    expect(config).toContain("command: cat spec-source.json > generated.json");
    expect(config).toContain("out: generated.json");
  });

  it("will not guess between two specifications", async () => {
    const spec = await acme();
    const root = await repository({ "a/openapi.json": spec, "b/openapi.json": spec });
    const result = await invariant(root, ["init"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("more than one OpenAPI document");
    expect(result.stderr).toContain("a/openapi.json");
    expect(result.stderr).toContain("b/openapi.json");
  });

  it("says how to generate one when the specification comes from code", async () => {
    const root = await repository({
      "package.json": JSON.stringify({ dependencies: { "@nestjs/swagger": "^8.0.0" } }),
    });
    const result = await invariant(root, ["init"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No OpenAPI document was found");
    expect(result.stderr).toContain("NestJS Swagger");
    expect(result.stderr).toContain("--spec-command");
  });

  it("does not replace a configuration that already exists", async () => {
    const root = await repository({ "openapi.json": await acme() });
    await invariant(root, ["init", "--no-ci"]);
    const again = await invariant(root, ["init", "--no-ci"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already exists");
  });

  it("refuses a document the gate could not read, and says why, now", async () => {
    const document = JSON.parse(await acme());
    document.paths["/v1/payments"].post.responses["201"].content[
      "application/json"
    ].schema = {
      $ref: "#/components/schemas/Missing",
    };
    const root = await repository({ "openapi.json": JSON.stringify(document) });
    const result = await invariant(root, ["init", "--no-ci"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("#/components/schemas/Missing");
  });
});

describe("the version header", () => {
  it("is read from the document when it declares one", () => {
    const parameter = {
      name: "Stripe-Version",
      in: "header",
      schema: { type: "string" },
    };
    const document = {
      openapi: "3.0.0",
      paths: {
        "/v1/charges": {
          get: {
            parameters: [{ $ref: "#/components/parameters/Version" }],
            responses: {},
          },
          post: { parameters: [parameter], responses: {} },
        },
        "/v1/customers": {
          get: {
            parameters: [
              { name: "expand", in: "query" },
              { name: "Idempotency-Key", in: "header" },
            ],
            responses: {},
          },
        },
      },
      components: { parameters: { Version: parameter } },
    };
    expect(versionHeader(document)).toBe("Stripe-Version");
  });

  it("is not invented when the document declares none", async () => {
    expect(versionHeader(JSON.parse(await acme()))).toBeUndefined();
  });
});
