import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripeDirectoryNamespaces } from "./generators.ts";
import { normalizePath, readGo, readPython, readTypeScript } from "./index.ts";

/** A throwaway release from a map of relative paths to their text. */
function release(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "symbols-read-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const FIXTURES = join(import.meta.dirname, "../fixtures");

describe("readPython", () => {
  it("names a class through the star imports that re-export it, as stripe 5 does", () => {
    const root = release({
      "stripe/__init__.py":
        "api_key = None\nfrom stripe.api_resources import *  # noqa\n",
      "stripe/api_resources/__init__.py": [
        "from stripe.api_resources import checkout",
        "from stripe.api_resources.customer import Customer",
        "",
      ].join("\n"),
      "stripe/api_resources/customer.py":
        'class Customer(StripeObject):\n    OBJECT_NAME = "customer"\n',
      "stripe/api_resources/checkout/__init__.py":
        "from stripe.api_resources.checkout.session import Session\n",
      "stripe/api_resources/checkout/session.py":
        'class Session(StripeObject):\n    OBJECT_NAME = "checkout.session"\n',
    });
    const { declarations } = readPython(root, "stripe");
    expect(declarations.map((each) => [each.qualified, each.constants])).toEqual(
      expect.arrayContaining([
        ["stripe.Customer", { object: "customer" }],
        ["stripe.checkout.Session", { object: "checkout.session" }],
      ]),
    );
  });

  it("does not count a module's own imports as re-exports", () => {
    const root = release({
      "sdk/__init__.py": "from . import types, resources\n",
      "sdk/types/__init__.py": "",
      "sdk/types/chat/__init__.py": "from .completion import Completion as Completion\n",
      "sdk/types/chat/completion.py": "class Completion(BaseModel):\n    id: str\n",
      "sdk/resources/__init__.py": "",
      "sdk/resources/chat.py":
        "from ..types.chat.completion import Completion\n\nclass Chat:\n    pass\n",
    });
    const completion = readPython(root, "sdk").declarations.find(
      (each) => each.name === "Completion",
    );
    expect(completion).toMatchObject({
      qualified: "sdk.types.chat.Completion",
      exported: true,
    });
  });

  it("reads fields, not docstrings or blocks, and takes each alias as the wire name", () => {
    const root = release({
      "sdk/__init__.py": "",
      "sdk/types/__init__.py": "",
      "sdk/types/embeddings.py": [
        "class Embeddings(",
        "    UncheckedBaseModel,",
        "):",
        '    """',
        "    Example:",
        '    """',
        "",
        "    float_: typing_extensions.Annotated[",
        "        typing.Optional[typing.List[float]],",
        '        pydantic.Field(alias="float"),',
        "    ] = None",
        "    int8: Optional[List[int]] = None",
        '    type: Literal["embeddings"]',
        "    OBJECT_NAME: ClassVar[str] = 'x'",
        "",
        "    if IS_PYDANTIC_V2:",
        "        model_config = ConfigDict(extra='allow')",
        "    else:",
        "",
        "        class Config:",
        "            extra = 'allow'",
        "",
      ].join("\n"),
    });
    const [embeddings] = readPython(root, "sdk").declarations;
    expect(embeddings).toMatchObject({
      qualified: "sdk.types.embeddings.Embeddings",
      fields: ["float", "int8", "type"],
      constants: { type: "embeddings" },
    });
  });

  it("reaches models Speakeasy and Fern export lazily", () => {
    const { declarations } = readPython(join(FIXTURES, "speakeasy-python"), "mistralai");
    expect(declarations.map((each) => each.qualified)).toEqual(
      expect.arrayContaining([
        "mistralai.client.models.UsageInfo",
        "mistralai.client.models.UsageInfoTypedDict",
      ]),
    );
    expect(declarations.find((each) => each.name === "UsageInfoTypedDict")?.input).toBe(
      true,
    );
  });

  it("follows a method's request into the private helper that makes it", () => {
    const { calls } = readPython(
      join(FIXTURES, "openapi-generator-python"),
      "ory_client",
    );
    expect(
      calls
        .filter((each) => each.path === "/admin/identities/{id}")
        .map((each) => [each.method, each.through]),
    ).toEqual([
      ["delete_identity", "ory_client.IdentityApi._delete_identity_serialize"],
      [
        "delete_identity_with_http_info",
        "ory_client.IdentityApi._delete_identity_serialize",
      ],
      ["_delete_identity_serialize", undefined],
    ]);
  });
});

describe("readTypeScript", () => {
  it("merges an ambient namespace across files and keeps two modules' types apart", () => {
    const root = release({
      "types/A.d.ts":
        "declare module 'x' { namespace X { interface Thing { a: string } } }\n",
      "types/B.d.ts":
        "declare module 'x' { namespace X { interface Thing { b: string } } }\n",
      "cjs/one.d.ts": "export interface Session { id: string; object: 'one'; }\n",
      "cjs/two.d.ts": "export interface Session { id: string; object: 'two'; }\n",
      "esm/one.d.ts": "export interface Session { id: string; object: 'one'; }\n",
    });
    const { declarations } = readTypeScript(root);
    expect(declarations.find((each) => each.qualified === "X.Thing")?.fields).toEqual([
      "a",
      "b",
    ]);
    expect(
      declarations
        .filter((each) => each.qualified === "Session")
        .map((each) => each.constants?.["object"])
        .sort(),
    ).toEqual(["one", "two"]);
  });

  it("gives a type the fields of what it extends", () => {
    const root = release({
      "index.d.ts": [
        "export interface Base { id: string; object: 'event'; }",
        "export interface Created extends Base { type: 'created'; }",
        "export type Updated = Base & { type: 'updated' };",
        "",
      ].join("\n"),
    });
    const { declarations } = readTypeScript(root);
    expect(declarations.find((each) => each.name === "Created")).toMatchObject({
      fields: ["type", "id", "object"],
      constants: { object: "event", type: "created" },
      extends: ["Base"],
    });
    expect(declarations.find((each) => each.name === "Updated")?.fields).toEqual([
      "type",
      "id",
      "object",
    ]);
  });

  it("gives a union of object types the fields and pinned values its variants share", () => {
    const root = release({
      "index.d.ts": [
        "export interface EventBase { id: string; object: 'event'; }",
        "export interface ChargeEvent extends EventBase { type: 'charge'; data: string; }",
        "export interface RefundEvent extends EventBase { type: 'refund'; data: number; }",
        "export type Event = ChargeEvent | RefundEvent;",
        "export type Id = string | number;",
        "",
      ].join("\n"),
    });
    const { declarations } = readTypeScript(root);
    expect(declarations.find((each) => each.name === "Event")).toMatchObject({
      kind: "alias",
      variants: ["ChargeEvent", "RefundEvent"],
      fields: ["type", "data", "id", "object"],
      constants: { object: "event" },
    });
    expect(declarations.find((each) => each.name === "Id")?.variants).toBeUndefined();
  });
});

describe("stripeDirectoryNamespaces", () => {
  it("names stripe-node 22's types through their directory, nested types included", () => {
    const root = release({
      // 22.0 to 22.1 nests a type's types in a namespace for its directory.
      "cjs/resources/Checkout/Sessions.d.ts": [
        "import { StripeResource } from '../../StripeResource.js';",
        "export interface Session { id: string; object: 'checkout.session'; }",
        "export declare namespace Checkout {",
        "    namespace Session { interface AutomaticTax { enabled: boolean; } }",
        "    interface SessionCreateParams { mode?: string; }",
        "}",
        "",
      ].join("\n"),
      // From 22.3, in a namespace for the type alone.
      "cjs/resources/Billing/Alerts.d.ts": [
        "import { StripeResource } from '../../StripeResource.js';",
        "export interface Alert { id: string; object: 'billing.alert'; }",
        "export declare namespace Alert { interface UsageThreshold { gte: number; } }",
        "",
      ].join("\n"),
      // And one already in its directory's namespace.
      "cjs/resources/V2/Billing/MeterEventStream.d.ts": [
        "import { StripeResource } from '../../../StripeResource.js';",
        "export declare namespace V2.Billing { interface MeterEventStreamCreateParams { events: string[]; } }",
        "",
      ].join("\n"),
    });
    const { declarations, calls } = readTypeScript(root);
    stripeDirectoryNamespaces(declarations, calls);
    expect(
      Object.fromEntries(
        declarations.map((each) => [each.qualified, each.parent ?? null]),
      ),
    ).toEqual({
      "Checkout.Session": null,
      "Checkout.Session.AutomaticTax": "Checkout.Session",
      "Checkout.SessionCreateParams": null,
      "Billing.Alert": null,
      "Billing.Alert.UsageThreshold": "Billing.Alert",
      "V2.Billing.MeterEventStreamCreateParams": null,
    });
  });
});

describe("readGo", () => {
  it("reads json tags, and ignores an untagged field beside tagged ones", () => {
    const { declarations } = readGo(join(FIXTURES, "openapi-generator-go"));
    expect(declarations.find((each) => each.name === "JsonPatch")?.fields).toEqual([
      "from",
      "op",
      "path",
      "value",
    ]);
  });
});

describe("normalizePath", () => {
  it("writes every parameter as {} whatever the SDK interpolates with", () => {
    expect(normalizePath("/v1/invoices/{invoice}")).toBe("v1/invoices/{}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an SDK's template path as its source spells it, not an interpolation
    expect(normalizePath("/v1/invoices/${encodeURIComponent(id)}")).toBe(
      "v1/invoices/{}",
    );
    expect(normalizePath("v1/messages/batches/%s")).toBe("v1/messages/batches/{}");
    expect(normalizePath("/v1/chat/completions#stream")).toBe("v1/chat/completions");
    expect(normalizePath("/v1/messages/batches?beta=true")).toBe(
      "v1/messages/batches?beta=true",
    );
  });
});
