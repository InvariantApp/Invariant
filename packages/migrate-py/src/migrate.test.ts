import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Change } from "@invariant-app/ir";
import { buildPlan } from "@invariant-app/migrate-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, originalOffset } from "./index.ts";

/**
 * A small typed SDK in the shape stripe-python has had since 7.0: classes
 * with annotated fields, a nested class for a list's items, a module-level
 * API version and a client that takes one per instance.
 */
const SDK_OLD = {
  "acme/__init__.py": [
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
  "acme/_subscription.py": [
    "from typing import List, Optional",
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
    "",
    "    @classmethod",
    '    def retrieve(cls, id: str) -> "Subscription": ...',
    "",
  ].join("\n"),
};

/** The next release: `legacy` is gone and the fields follow the new contract. */
const SDK_NEW = {
  "acme/__init__.py": SDK_OLD["acme/__init__.py"]
    .replace('"2024-01-01"', '"2025-01-01"')
    .replace("\n\ndef legacy() -> None: ...\n", "\n"),
  "acme/_subscription.py": SDK_OLD["acme/_subscription.py"]
    .replace("    current_period_end: int\n", "")
    .replace("cancel_at:", "cancels_at:"),
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
  await writeTree(join(root, "repo"), { "app.py": CONSUMER });
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
      types: { subscription: "acme.Subscription" },
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

    expect(result.targets).toEqual({ resolved: 3, unresolved: 0 });
    const migrated = result.files.get(app) ?? "";
    expect(migrated).toContain('acme.api_version = "2025-01-01"');
    expect(migrated).toContain('if sub.status == "overdue":');
    expect(migrated).toContain("print(sub.cancels_at)");
    expect(migrated).toContain('acme_version="2025-01-01"');
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
    // The removed field's read breaks too; it is already reported above, and
    // the renamed field's edit left nothing behind.
    expect(result.manual.some((site) => site.line === 9)).toBe(false);
  }, 60_000);
});

describe("the API version a consumer pins", () => {
  it("is moved where it followed the SDK, through a settings module, and shown where it was chosen", async () => {
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
    // The settings module is edited where the version is written, once.
    expect(result.files.get(join(repo, "settings.py"))).toBe(
      'ACME_VERSION = "2025-01-01"\nOTHER = "2023-06-01"\n',
    );
    // The consumer's own function that takes the same keyword is not the SDK's.
    expect(result.files.has(join(repo, "client.py"))).toBe(false);
    expect(result.manual.map((site) => [site.file.slice(repo.length + 1), site.line])).toEqual([
      ["settings.py", 2],
    ]);
  }, 60_000);
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
