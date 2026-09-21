/**
 * A specification kept across files, assembled the way `loadContract` reads
 * it, from real files in a scratch repository.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleDocument, refersOutside } from "./bundle.ts";
import { ContractError, loadContract } from "./spec.ts";

/** What sits at a path of keys in a parsed document. */
function pick(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    value,
  );
}

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A repository holding these files, as a provider's would. */
async function repository(files: Record<string, string>): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-bundle-"));
  await mkdir(join(scratch, ".git"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(scratch, path)), { recursive: true });
    await writeFile(join(scratch, path), text, "utf8");
  }
  return scratch;
}

const SPLIT = {
  "api/openapi.yaml": `
openapi: 3.0.3
info: { title: pets, version: "1" }
paths:
  /pets/{id}:
    $ref: ./paths/pet.yaml
components:
  schemas:
    Error:
      type: object
      properties:
        message: { type: string }
`,
  "api/paths/pet.yaml": `
get:
  operationId: getPet
  parameters:
    - $ref: ../parameters.yaml#/PetId
  responses:
    "200":
      description: a pet
      content:
        application/json:
          schema: { $ref: ../schemas/Pet.yaml }
    "404":
      description: missing
      content:
        application/json:
          schema: { $ref: ../openapi.yaml#/components/schemas/Error }
`,
  "api/parameters.yaml": `
PetId:
  name: id
  in: path
  required: true
  schema: { type: string }
`,
  "api/schemas/Pet.yaml": `
type: object
required: [id]
properties:
  id: { type: string }
  tag: { $ref: ./Tag.yaml }
  parent: { $ref: ./Pet.yaml }
  owner: { $ref: "./common.yaml#/Error" }
`,
  "api/schemas/Tag.yaml": `
type: object
properties:
  name: { type: string }
`,
  "api/schemas/common.yaml": `
Error:
  type: object
  properties:
    code: { type: integer }
`,
};

describe("a specification kept across files", () => {
  it("is read as the one document it describes", async () => {
    const root = await repository(SPLIT);
    const contract = await loadContract(join(root, "api/openapi.yaml"), "v1");
    const document = contract.document;

    expect(refersOutside(document)).toBe(false);
    // A path item and a parameter are written in where they were referenced.
    const get = pick(document, "paths", "/pets/{id}", "get");
    expect(pick(get, "operationId")).toBe("getPet");
    expect(pick(get, "parameters", "0")).toEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    // A schema is named, so a Change can be scoped to it.
    const schemas = pick(document, "components", "schemas");
    expect(
      pick(get, "responses", "200", "content", "application/json", "schema"),
    ).toEqual({
      $ref: "#/components/schemas/Pet",
    });
    expect(pick(schemas, "Pet", "properties", "tag")).toEqual({
      $ref: "#/components/schemas/Tag",
    });
    // A schema that contains itself refers to its own name.
    expect(pick(schemas, "Pet", "properties", "parent")).toEqual({
      $ref: "#/components/schemas/Pet",
    });
    // A reference back into the document stays a reference into it.
    expect(
      pick(get, "responses", "404", "content", "application/json", "schema"),
    ).toEqual({
      $ref: "#/components/schemas/Error",
    });
    // A second schema called Error, from another file, does not replace the first.
    expect(pick(schemas, "Pet", "properties", "owner")).toEqual({
      $ref: "#/components/schemas/Error_2",
    });
    expect(pick(schemas, "Error", "properties")).toEqual({ message: { type: "string" } });
    expect(pick(schemas, "Error_2", "properties")).toEqual({ code: { type: "integer" } });
  });

  it("is refused where a reference leaves the repository", async () => {
    const root = await repository({
      "openapi.yaml": `
openapi: 3.0.3
info: { title: t, version: "1" }
paths: {}
components:
  schemas:
    Secret: { $ref: ../../etc/passwd }
`,
    });
    await expect(loadContract(join(root, "openapi.yaml"), "v1")).rejects.toThrow(
      /outside the repository/,
    );
    await expect(loadContract(join(root, "openapi.yaml"), "v1")).rejects.toBeInstanceOf(
      ContractError,
    );
  });

  it("is never fetched from a URL", async () => {
    const root = await repository({
      "openapi.yaml": `
openapi: 3.0.3
info: { title: t, version: "1" }
paths: {}
components:
  schemas:
    Remote: { $ref: "https://example.com/schemas/pet.yaml" }
`,
    });
    await expect(loadContract(join(root, "openapi.yaml"), "v1")).rejects.toThrow(
      /never fetched/,
    );
  });

  it("names a missing file and the file that refers to it", async () => {
    const root = await repository({
      "openapi.yaml": `
openapi: 3.0.3
info: { title: t, version: "1" }
paths:
  /a: { $ref: ./paths/a.yaml }
`,
    });
    await expect(loadContract(join(root, "openapi.yaml"), "v1")).rejects.toThrow(
      /paths\/a\.yaml, which cannot be read/,
    );
  });

  it("assembles a Swagger 2.0 document into its definitions, then upgrades it", async () => {
    const root = await repository({
      "swagger.yaml": `
swagger: "2.0"
info: { title: t, version: "1" }
paths:
  /pets:
    get:
      responses:
        "200":
          description: ok
          schema:
            type: array
            items: { $ref: ./definitions/Pet.yaml }
`,
      "definitions/Pet.yaml": `
type: object
properties:
  name: { type: string }
`,
    });
    const bundled = await bundleDocument(join(root, "swagger.yaml"));
    expect(Object.keys(pick(bundled, "definitions") as object)).toEqual(["Pet"]);
    const contract = await loadContract(join(root, "swagger.yaml"), "v1");
    expect(pick(contract.document, "components", "schemas", "Pet")).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  it("returns a document that stands alone exactly as it was", async () => {
    const root = await repository({
      "openapi.json": JSON.stringify({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {},
      }),
    });
    expect(await bundleDocument(join(root, "openapi.json"))).toEqual({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {},
    });
  });
});
