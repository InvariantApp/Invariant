import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Change } from "@invariant-app/ir";
import { buildPlan } from "@invariant-app/migrate-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { breaks, migrate, originalOffset } from "./index.ts";

/**
 * A small typed SDK in the shape stripe-python has had since 7.0: classes
 * with annotated fields, a nested class for a list's items, a module-level
 * API version and a client that takes one per instance.
 */
const SDK_OLD = {
  // Its types are shipped for checking, so every new error across the
  // upgrade counts, not only the ones that break at runtime.
  "acme/py.typed": "",
  "acme/__init__.py": [
    "from acme._calls import Completion as Completion",
    "from acme._calls import Widget as Widget",
    "from acme._calls import charge as charge",
    "from acme._subscription import Invoice as Invoice",
    "from acme._subscription import Subscription as Subscription",
    "",
    'api_version: str = "2024-01-01"',
    "",
    "",
    "class Client:",
    "    def __init__(self, api_key: str, acme_version: str | None = None) -> None: ...",
    "",
    "",
    "def legacy() -> None: ...",
    "",
  ].join("\n"),
  "acme/_calls.py": [
    "from typing import Any",
    "",
    "",
    "class Completion:",
    "    @classmethod",
    "    def create(cls, **kwargs: Any) -> Any: ...",
    "",
    "",
    "class Widget:",
    "    def __init__(self, name: str, size: int) -> None: ...",
    "",
    "",
    'def charge(amount: str, engine: str, prompt: str = "") -> None: ...',
    "",
  ].join("\n"),
  "acme/_subscription.py": [
    "from typing import List, Literal, Optional",
    "",
    "",
    "class Subscription:",
    "    class Item:",
    "        price: str",
    "        period_end: int",
    "",
    "    id: str",
    "    status: str",
    "    current_period_end: int",
    "    cancel_at: Optional[int]",
    '    items: List["Subscription.Item"]',
    '    latest_invoice: Optional["Invoice"]',
    '    tier: Literal["gold", "silver"]',
    "",
    "    @classmethod",
    '    def retrieve(cls, id: str) -> "Subscription": ...',
    "",
    "    @classmethod",
    '    def create(cls, customer: str, expand: Optional[List[str]] = None) -> "Subscription": ...',
    "",
    "",
    "class Invoice:",
    "    id: str",
    "    payment_intent: Optional[str]",
    "",
  ].join("\n"),
};

/** The next release: `legacy` is gone and the fields follow the new contract. */
const SDK_NEW = {
  "acme/py.typed": "",
  "acme/__init__.py": SDK_OLD["acme/__init__.py"]
    .replace('"2024-01-01"', '"2025-01-01"')
    .replace("\n\ndef legacy() -> None: ...\n", "\n")
    .replace("from acme._calls import Completion as Completion\n", "")
    .replace("from acme._calls import Widget as Widget\n", ""),
  // `Completion` and `Widget` are gone, and `charge` renamed a parameter.
  "acme/_calls.py": [
    'def charge(amount: str, model: str, prompt: str = "") -> None: ...',
    "",
  ].join("\n"),
  "acme/_subscription.py": SDK_OLD["acme/_subscription.py"]
    .replace("    current_period_end: int\n", "")
    .replace("cancel_at:", "cancels_at:")
    .replace('Literal["gold", "silver"]', 'Literal["gold", "silver", "bronze"]'),
};

const CONSUMER = [
  "import acme",
  "",
  'acme.api_version = "2024-01-01"',
  "",
  "",
  "def period(id: str) -> int:",
  "    sub = acme.Subscription.retrieve(id)",
  '    if sub.status == "past_due":',
  "        print(sub.cancel_at)",
  "    return sub.current_period_end",
  "",
  "",
  "def webhook(event):",
  '    obj = event["data"]["object"]',
  '    return obj["current_period_end"]',
  "",
  "",
  "class Order:",
  "    status: str",
  "",
  "",
  "def unrelated(order: Order) -> bool:",
  '    return order.status == "past_due"',
  "",
  "",
  'client = acme.Client("key", acme_version="2024-01-01")',
  "acme.legacy()",
  'acme.Subscription.create("cus_1", expand=["latest_invoice.payment_intent"])',
  "",
  "",
  "def label(sub: acme.Subscription) -> str:",
  "    match sub.tier:",
  '        case "gold":',
  '            return "G"',
  '        case "silver":',
  '            return "S"',
  "",
  "",
  "def show(sub: acme.Subscription) -> str:",
  "    from labels import tier_label",
  "",
  "    return tier_label(sub.tier)",
  "",
].join("\n");

/** The consumer's own copy of the SDK's values, in a module that never imports it. */
const LABELS = [
  "from typing import Literal",
  "",
  "",
  'def tier_label(tier: Literal["gold", "silver"]) -> str:',
  "    match tier:",
  '        case "gold":',
  '            return "G"',
  '        case "silver":',
  '            return "S"',
  "",
].join("\n");

const changes: Change[] = [
  {
    irVersion: 1,
    id: "chg_cancel_at",
    summary: "`cancel_at` is now `cancels_at`.",
    scopes: [{ schema: "#/components/schemas/subscription" }],
    ops: [{ op: "move", from: "/cancel_at", to: "/cancels_at" }],
  },
  {
    irVersion: 1,
    id: "chg_period_end",
    summary: "`current_period_end` is no longer in `subscription`.",
    scopes: [{ schema: "#/components/schemas/subscription" }],
    ops: [{ op: "remove", path: "/current_period_end", restore: null }],
  },
  {
    irVersion: 1,
    id: "chg_status",
    summary: "`past_due` is now `overdue`.",
    scopes: [{ schema: "#/components/schemas/subscription" }],
    ops: [
      {
        op: "convert",
        path: "/status",
        codec: { kind: "enumMap", pairs: [["past_due", "overdue"]] },
      },
    ],
  },
  {
    irVersion: 1,
    id: "chg_payment_intent",
    summary: "`payment_intent` is no longer in `invoice`.",
    scopes: [{ schema: "#/components/schemas/invoice" }],
    ops: [{ op: "remove", path: "/payment_intent", restore: null }],
  },
] as Change[];

let root: string;

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "migrate-py-"));
  await writeTree(join(root, "old"), SDK_OLD);
  await writeTree(join(root, "new"), SDK_NEW);
  await writeTree(join(root, "repo"), { "app.py": CONSUMER, "labels.py": LABELS });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a Python migration", () => {
  it("edits what types prove, reports the rest, and checks the result against the new release", async () => {
    const app = join(root, "repo", "app.py");
    const plan = buildPlan(changes, {
      package: "acme",
      upgradeTo: { package: "acme", version: "2.0.0" },
      types: { subscription: "acme.Subscription", invoice: "acme.Invoice" },
      accessors: [],
      pin: {
        type: "acme",
        property: "api_version",
        label: "2025-01-01",
        from: "2024-01-01",
        keywords: ["acme_version"],
      },
    });
    const result = await migrate({
      repoDir: join(root, "repo"),
      sources: [app],
      packages: [join(root, "old")],
      upgraded: [join(root, "new")],
      plan,
    });

    expect(result.targets).toEqual({ resolved: 4, unresolved: 0 });
    // A removed field named in an expansion, reached through the type the
    // call returns.
    expect(
      result.manual.some(
        (site) =>
          site.line === 28 &&
          site.reason.startsWith("this expands `latest_invoice.payment_intent`"),
      ),
    ).toBe(true);
    const migrated = result.files.get(app) ?? "";
    expect(migrated).toContain('if sub.status == "overdue":');
    expect(migrated).toContain("print(sub.cancels_at)");
    // The pins, module-wide and per client, are shown and left as written.
    expect(migrated).toContain('acme.api_version = "2024-01-01"');
    expect(migrated).toContain('acme_version="2024-01-01"');
    expect(
      result.manual
        .filter((site) => site.reason.startsWith("this pins API version 2024-01-01"))
        .map((site) => site.line),
    ).toEqual([3, 26]);
    // The Django-like model's own `status` is not the SDK's, and stays.
    expect(migrated).toContain('return order.status == "past_due"');

    const manual = result.manual.map(
      (site) => `${site.line} ${site.reason.split(";")[0]}`,
    );
    expect(manual).toEqual(
      expect.arrayContaining([
        "10 `current_period_end` is no longer in the contract, and nothing was declared in its place",
        "15 `current_period_end` is no longer in the contract, and nothing was declared in its place",
      ]),
    );
    // The upgrade's own break, which no Change named: `legacy` is gone.
    expect(
      result.manual.some(
        (site) => site.line === 27 && /no longer type-checks.*legacy/.test(site.reason),
      ),
    ).toBe(true);
    // A value the new release adds makes a match over the old ones incomplete,
    // and the whole match is shown, since the fix is a new case in it.
    const match = result.manual.find((site) => /bronze/.test(site.reason));
    expect(match && [match.line, match.snippet, (match.end ?? 0) - match.offset]).toEqual(
      [
        32,
        "match sub.tier:",
        CONSUMER.slice(
          CONSUMER.indexOf("match sub.tier"),
          CONSUMER.indexOf("\n\n", CONSUMER.indexOf("match sub.tier")),
        ).length,
      ],
    );
    // The same value passed to the consumer's own copy of the old values: its
    // signature and its match are what need the new value.
    expect(
      result.manual
        .filter((site) => site.file.endsWith("labels.py"))
        .map((site) => site.line)
        .sort(),
    ).toEqual([4, 5]);
    // The removed field's read breaks too; it is already reported above, and
    // the renamed field's edit left nothing behind.
    expect(result.manual.some((site) => site.line === 9)).toBe(false);
  }, 60_000);
});

describe("what the checker cannot see", () => {
  it("follows values and prebuilt keyword arguments to where they are written", async () => {
    const repo = join(root, "flows");
    const calls = [
      "import acme",
      "from acme import Widget",
      "",
      "",
      "def pay(amount: str) -> None:",
      '    params = {"amount": amount, "engine": "fast"}',
      '    params["prompt"] = "hi"',
      "    acme.charge(**params)",
      "",
      "",
      "def legacy(prompt: str):",
      "    raw_request = {",
      '        "engine": "davinci",',
      '        "prompt": prompt,',
      "    }",
      "",
      "    def do_it():",
      "        return acme.Completion.create(**raw_request)",
      "",
      "    return do_it()",
      "",
      "",
      "WIDGETS = [",
      "    Widget(",
      '        name="a",',
      "        size=1,",
      "    ),",
      "]",
      "",
      "",
      "def period(sub):",
      '    return sub["cancel_at"]',
      "",
      "",
      "def run() -> None:",
      '    period(acme.Subscription.retrieve("sub_1"))',
      "",
      "",
      "def invoice_period(inv):",
      '    return inv["cancel_at"]',
      "",
      "",
      "def run_invoice(invoice: acme.Invoice) -> None:",
      "    invoice_period(invoice)",
      "",
    ].join("\n");
    await writeTree(repo, { "calls.py": calls });
    const file = join(repo, "calls.py");
    const result = await migrate({
      repoDir: repo,
      sources: [file],
      packages: [join(root, "old")],
      upgraded: [join(root, "new")],
      plan: buildPlan(changes, {
        package: "acme",
        upgradeTo: { package: "acme", version: "2.0.0" },
        types: { subscription: "acme.Subscription", invoice: "acme.Invoice" },
        accessors: [],
      }),
    });
    const at = (site: { offset: number; end?: number }) =>
      calls.slice(site.offset, site.end ?? site.offset);
    const reported = result.manual.map((site) => [site.line, site.reason.slice(0, 47)]);
    // A key the new release's `charge` no longer takes, where it is written.
    expect(reported).toContainEqual([
      6,
      "`engine` reaches `acme.charge` as a keyword arg",
    ]);
    const engine = result.manual.find((site) => site.line === 6);
    expect(engine && at(engine)).toBe('"engine": "fast"');
    // A callee that is gone: the call, and the dictionary it unpacks, whole.
    const dictionary = result.manual.find((site) =>
      site.reason.startsWith(
        "these are the keyword arguments of `acme.Completion.create`",
      ),
    );
    expect(dictionary && [dictionary.line, at(dictionary)]).toEqual([
      12,
      calls.slice(
        calls.indexOf('{\n        "engine": "davinci"'),
        calls.indexOf("}\n\n    def do_it") + 1,
      ),
    ]);
    // A class whose import fails: each call that builds one, whole.
    const widget = result.manual.find((site) =>
      site.reason.startsWith("`Widget` is no longer"),
    );
    expect(widget && [widget.line, at(widget)]).toEqual([
      24,
      'Widget(\n        name="a",\n        size=1,\n    )',
    ]);
    // A value followed to the SDK's call that made it is certainly a
    // Subscription, and its renamed field is rewritten; one followed to an
    // Invoice is not the field at all.
    const migrated = result.files.get(file) ?? "";
    expect(migrated).toContain('return sub["cancels_at"]');
    expect(migrated).toContain('return inv["cancel_at"]');
    expect(result.manual.some((site) => site.line === 40)).toBe(false);
  }, 60_000);
});

describe("an old release that ships no types", () => {
  it("reads a field by name only from a value proven to be its class", async () => {
    const repo = join(root, "untyped");
    const { "acme/py.typed": _, ...untyped } = SDK_OLD;
    await writeTree(join(root, "old-untyped"), untyped);
    await writeTree(repo, { "app.py": CONSUMER });
    const result = await migrate({
      repoDir: repo,
      sources: [join(repo, "app.py")],
      packages: [join(root, "old-untyped")],
      plan: buildPlan(changes, {
        package: "acme",
        upgradeTo: { package: "acme", version: "2.0.0" },
        types: { subscription: "acme.Subscription", invoice: "acme.Invoice" },
        accessors: [],
      }),
    });
    const lines = result.manual
      .filter((site) => site.reason.startsWith("`current_period_end`"))
      .map((site) => site.line);
    // The typed read is reported; the webhook's dictionary, which the
    // checker cannot type, is not read by name against a release like this.
    expect(lines).toEqual([10]);
  }, 60_000);
});

describe("the API version a consumer pins", () => {
  it("is shown where it is written, through a settings module, and never moved", async () => {
    const repo = join(root, "pins");
    await writeTree(repo, {
      "settings.py": 'ACME_VERSION = "2024-01-01"\nOTHER = "2023-06-01"\n',
      "client.py": [
        "import acme",
        "",
        "import settings",
        "",
        "acme.api_version = settings.ACME_VERSION",
        'legacy = acme.Client("key", acme_version=settings.OTHER)',
        "",
        "",
        "def mine(acme_version: str) -> str:",
        "    return acme_version",
        "",
        "",
        'mine(acme_version="2024-01-01")',
        "",
      ].join("\n"),
    });
    const result = await migrate({
      repoDir: repo,
      sources: [join(repo, "client.py")],
      packages: [join(root, "old")],
      plan: buildPlan([], {
        package: "acme",
        upgradeTo: { package: "acme", version: "2.0.0" },
        types: {},
        accessors: [],
        pin: {
          type: "acme",
          property: "api_version",
          label: "2025-01-01",
          from: "2024-01-01",
          keywords: ["acme_version"],
        },
      }),
    });
    // Nothing is moved; the settings module is shown where each version is
    // written, once, and the consumer's own function that takes the same
    // keyword is not the SDK's.
    expect(result.edits).toEqual([]);
    expect(
      result.manual.map((site) => [
        site.file.slice(repo.length + 1),
        site.line,
        site.reason.slice(0, 32),
      ]),
    ).toEqual([
      ["settings.py", 1, "this pins API version 2024-01-01"],
      ["settings.py", 2, "this pins API version 2023-06-01"],
    ]);
  }, 60_000);
});

describe("values a parameter no longer takes", () => {
  it("rewrites a literal a Change maps and shows one it does not, only where the SDK's own parameter lost it", async () => {
    // A models SDK: `model` takes any text or one of the listed models, and
    // the next release lists fewer. `size` lists its values in place.
    const models = (listed: string[], sizes: string[]) => ({
      "models/py.typed": "",
      "models/__init__.py": [
        "from models._types import ChatModel as ChatModel",
        "from models._client import Client as Client",
        "",
      ].join("\n"),
      "models/_types.py": [
        "from typing import Literal",
        "from typing_extensions import TypeAlias",
        "",
        `ChatModel: TypeAlias = Literal[${listed.map((name) => `"${name}"`).join(", ")}]`,
        "",
      ].join("\n"),
      "models/_client.py": [
        "from typing import Literal, Union, overload",
        "",
        "from models._types import ChatModel",
        "",
        "",
        "class Completions:",
        "    @overload",
        "    def create(self, *, model: Union[str, ChatModel], stream: Literal[True]) -> str: ...",
        "    @overload",
        "    def create(self, *, model: Union[str, ChatModel], stream: bool = False) -> str: ...",
        "    def create(self, *, model: Union[str, ChatModel], stream: bool = False) -> str: ...",
        "",
        `    def image(self, *, size: Union[str, Literal[${sizes.map((size) => `"${size}"`).join(", ")}]]) -> str: ...`,
        "",
        "",
        "class Client:",
        "    completions: Completions",
        "",
      ].join("\n"),
    });
    await writeTree(
      join(root, "models-old"),
      models(["m-1", "m-old", "m-gone"], ["256x256", "1024x1024"]),
    );
    await writeTree(join(root, "models-new"), models(["m-1", "m-2"], ["1024x1024"]));
    const repo = join(root, "values");
    await writeTree(repo, {
      "app.py": [
        "from models import Client",
        "",
        'DEFAULT = "m-gone"',
        "",
        "",
        "def ask(client: Client) -> None:",
        '    client.completions.create(model="m-old")',
        "    client.completions.create(model=DEFAULT, stream=True)",
        '    client.completions.create(model="m-1")',
        '    client.completions.image(size="256x256")',
        '    mine(model="m-old")',
        "",
        "",
        "def mine(model: str) -> str:",
        "    return model",
        "",
      ].join("\n"),
    });
    const plan = buildPlan(
      [
        {
          irVersion: 1,
          id: "chg_model",
          summary: "`m-old` is now `m-2`.",
          scopes: [{ operation: "createCompletion", location: "body" }],
          ops: [
            {
              op: "convert",
              path: "/model",
              codec: { kind: "enumMap", pairs: [["m-old", "m-2"]] },
            },
          ],
        },
      ] as Change[],
      {
        package: "models",
        upgradeTo: { package: "models", version: "2.0.0" },
        types: {},
        accessors: [],
      },
    );
    const app = join(repo, "app.py");
    const result = await migrate({
      repoDir: repo,
      sources: [app],
      packages: [join(root, "models-old")],
      upgraded: [join(root, "models-new")],
      plan,
    });
    // The Change maps `m-old`: rewritten where the SDK's `model` is sent,
    // and not in the consumer's own function that takes the same name.
    const migrated = result.files.get(app) ?? "";
    expect(migrated).toContain('client.completions.create(model="m-2")');
    expect(migrated).toContain('mine(model="m-old")');
    // Nothing maps `m-gone` or the smaller size: each is shown where it is
    // written, the constant where it is bound.
    expect(
      result.manual
        .filter((site) => /no longer lists it/.test(site.reason))
        .map((site) => [site.line, site.snippet]),
    ).toEqual([
      [3, 'DEFAULT = "m-gone"'],
      [10, 'client.completions.image(size="256x256")'],
    ]);
    // A value both releases list is left alone, and nothing else broke.
    expect(migrated).toContain('client.completions.create(model="m-1")');
    expect(result.diagnosticsAfter).toEqual([]);
  }, 60_000);
});

describe("which new errors count", () => {
  const at = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  it("counts what breaks, and not the checker first seeing an SDK's types", () => {
    const counted = [
      {
        code: "reportAttributeAccessIssue",
        message: '"error" is not a known attribute of module "stripe"',
      },
      { code: "reportCallIssue", message: 'No parameter named "body"' },
      {
        code: "reportMatchNotExhaustive",
        message: "Cases within match statement do not exhaustively handle all values",
      },
      {
        code: "reportOptionalMemberAccess",
        message: '"id" is not a known attribute of "None"',
      },
      {
        code: "reportAttributeAccessIssue",
        message: 'Cannot access attribute "id" for class "str"',
      },
      {
        code: "reportAttributeAccessIssue",
        message:
          'Cannot access attribute "stripe_id" for class "Session"\n  Attribute "stripe_id" is unknown',
      },
      {
        code: "reportAttributeAccessIssue",
        message: 'Cannot access attribute "items" for class "AsyncResult[Unknown]"',
      },
    ].map((diagnostic) => breaks({ range: at, ...diagnostic }, new Set(["Session"])));
    // A member missing from a class of the SDK's own counts; one missing from
    // the standard library's `AsyncResult`, in a union with it, does not.
    expect(counted).toEqual([true, true, true, false, false, true, false]);
  });
});

describe("offsets across edits", () => {
  it("maps an offset in the edited text back to the text as it was read", () => {
    const edits = [
      {
        file: "f",
        start: 2,
        end: 4,
        replacement: "abcd",
        changeId: "",
        author: "codemod" as const,
        reason: "",
      },
    ];
    // "01XX567" became "01abcd567": 5 is still before, 7 was 5.
    expect(originalOffset(1, edits)).toBe(1);
    expect(originalOffset(3, edits)).toBe(2);
    expect(originalOffset(7, edits)).toBe(5);
  });
});
