/**
 * The golden vectors: what a compiled program means, independently of this
 * implementation.
 *
 * The design calls for the interpreter to be portable - a Rust or Go engine
 * behind the same IR - and the way that stays honest is a set of cases stated
 * as data rather than as TypeScript. Anything claiming to run this IR has to
 * produce these outputs, including the refusals, and a refusal is as much part
 * of the contract as a result: an engine that quietly rounds where this one
 * rejects is not compatible, it is dangerous.
 */
import type { Instr } from "@invariant-app/ir";

export interface Vector {
  name: string;
  /** Why this case is in the list at all. */
  why: string;
  instrs: Instr[];
  /** The contract's named blocks, which `call` runs, when the case needs any. */
  blocks?: Record<string, Instr[]>;
  /**
   * The program's own blocks, shared by every contract, as a chain of
   * contracts links each one's work to the next contract's.
   */
  programBlocks?: Record<string, Instr[]>;
  input: unknown;
  /**
   * The cap on places one instruction may touch, when the case is about it.
   * Absent means the engine's default, which must be at least 10,000.
   */
  maxMatches?: number;
  /** Expected output, or the change id the transform must refuse with. */
  expect: { output: unknown } | { refuses: string };
}

const C = "chg_vector";

export const CONFORMANCE_VECTORS: Vector[] = [
  {
    name: "move renames a field",
    why: "The simplest op, and the one every other case is built on.",
    instrs: [{ k: "move", from: "/amount", to: "/amount_cents", c: C }],
    input: { amount: 100, currency: "usd" },
    expect: { output: { currency: "usd", amount_cents: 100 } },
  },
  {
    name: "move into a nested object creates the parent",
    why: "Unnesting and nesting are the same op, so the target may not exist.",
    instrs: [{ k: "move", from: "/source", to: "/payment_method/token", c: C }],
    input: { source: "tok_visa" },
    expect: { output: { payment_method: { token: "tok_visa" } } },
  },
  {
    name: "move out of a nested object prunes the empty parent",
    why: "Leaving `payment_method: {}` behind would not match the old contract.",
    instrs: [{ k: "move", from: "/payment_method/token", to: "/source", c: C }],
    input: { payment_method: { token: "tok_visa" }, id: "pay_1" },
    expect: { output: { id: "pay_1", source: "tok_visa" } },
  },
  {
    name: "move does nothing when the field is absent",
    why: "An optional field a caller did not send must not appear as null.",
    instrs: [{ k: "move", from: "/amount", to: "/amount_cents", c: C }],
    input: { currency: "usd" },
    expect: { output: { currency: "usd" } },
  },
  {
    name: "scale moves the decimal point right",
    why: "Multiplying by a hundred is wrong: 19.99 * 100 is 1998.9999999999998.",
    instrs: [{ k: "scale", path: "/amount", exp: 2, c: C }],
    input: { amount: 19.99 },
    expect: { output: { amount: 1999 } },
  },
  {
    name: "scale moves the decimal point left",
    why: "The inverse has to be exact too, or a round trip loses money.",
    instrs: [{ k: "scale", path: "/amount", exp: -2, c: C }],
    input: { amount: 1999 },
    expect: { output: { amount: 19.99 } },
  },
  {
    name: "scale refuses a value it cannot represent exactly",
    why:
      "Three decimal places scaled by two leaves a fraction of a minor unit. " +
      "Rounding here would be silent data loss in money, so it refuses.",
    instrs: [{ k: "scale", path: "/amount", exp: 2, c: C }],
    input: { amount: 49.999 },
    expect: { refuses: C },
  },
  {
    name: "scale keeps a large integer exact",
    why: "A value beyond double precision must not be rounded on the way through.",
    instrs: [{ k: "scale", path: "/amount", exp: 2, c: C }],
    input: { amount: 12345678901 },
    expect: { output: { amount: 1234567890100 } },
  },
  {
    name: "enum maps a known value",
    why: "The ordinary vocabulary change.",
    instrs: [{ k: "enum", path: "/status", map: { paid: "succeeded" }, c: C }],
    input: { status: "paid" },
    expect: { output: { status: "succeeded" } },
  },
  {
    name: "enum refuses a value it has no mapping for",
    why:
      "Passing an unmapped value through would hand the caller a word its " +
      "contract never defined, and it would look like a success.",
    instrs: [{ k: "enum", path: "/status", map: { paid: "succeeded" }, c: C }],
    input: { status: "disputed" },
    expect: { refuses: C },
  },
  {
    name: "a lenient enum passes an unmapped value through",
    why:
      "Only for a field naming another field, such as an error's `param`. " +
      "An unfamiliar name there is harmless; failing the response is not.",
    instrs: [
      { k: "enum", path: "/param", map: { amount_cents: "amount" }, lenient: true, c: C },
    ],
    input: { param: "currency" },
    expect: { output: { param: "currency" } },
  },
  {
    name: "set fills a field the caller omitted",
    why: "A caller written before a required field existed never sends one.",
    instrs: [
      { k: "set", path: "/capture_method", value: "automatic", ifAbsent: true, c: C },
    ],
    input: { amount: 1 },
    expect: { output: { amount: 1, capture_method: "automatic" } },
  },
  {
    name: "set leaves a value the caller did supply",
    why: "A default must never overwrite an explicit choice.",
    instrs: [
      { k: "set", path: "/capture_method", value: "automatic", ifAbsent: true, c: C },
    ],
    input: { capture_method: "manual" },
    expect: { output: { capture_method: "manual" } },
  },
  {
    name: "del removes a field",
    why: "The old contract never had it, so it must not be in the response.",
    instrs: [{ k: "del", path: "/capture_method", c: C }],
    input: { amount: 1, capture_method: "automatic" },
    expect: { output: { amount: 1 } },
  },
  {
    name: "set with ifNull fills a null and nothing else",
    why: "A response field that became nullable is shown to an old caller with the value the provider chose, and never created where it was absent.",
    instrs: [
      { k: "set", path: "/data/*/note", value: "", ifAbsent: false, ifNull: true, c: C },
    ],
    input: { data: [{ note: null }, { note: "kept" }, {}] },
    expect: { output: { data: [{ note: "" }, { note: "kept" }, {}] } },
  },
  {
    name: "set with ifAbsent and ifNull fills either",
    why: "A response field that became optional and nullable is always there, and never null, for an old caller.",
    instrs: [
      {
        k: "set",
        path: "/data/*/tier",
        value: "basic",
        ifAbsent: true,
        ifNull: true,
        c: C,
      },
    ],
    input: { data: [{ tier: null }, {}, { tier: "gold" }] },
    expect: {
      output: { data: [{ tier: "basic" }, { tier: "basic" }, { tier: "gold" }] },
    },
  },
  {
    name: "del with ifNull drops a null and nothing else",
    why: "A request field that no longer accepts null is left out when an old caller sends null, where the new contract lets it be absent.",
    instrs: [{ k: "del", path: "/description", ifNull: true, c: C }],
    input: { amount: 1, description: null },
    expect: { output: { amount: 1 } },
  },
  {
    name: "del with ifNull leaves a value",
    why: "Only the null the new contract refuses is dropped.",
    instrs: [{ k: "del", path: "/description", ifNull: true, c: C }],
    input: { amount: 1, description: "rent" },
    expect: { output: { amount: 1, description: "rent" } },
  },
  {
    name: "a wildcard applies to every element of a list",
    why: "A list envelope is the common shape and the one with a fan-out cost.",
    instrs: [{ k: "scale", path: "/data/*/amount", exp: -2, c: C }],
    input: { data: [{ amount: 1999 }, { amount: 500 }] },
    expect: { output: { data: [{ amount: 19.99 }, { amount: 5 }] } },
  },
  {
    name: "a wildcard over an empty list does nothing",
    why: "No elements is not an error, and must not be one.",
    instrs: [{ k: "scale", path: "/data/*/amount", exp: -2, c: C }],
    input: { data: [] },
    expect: { output: { data: [] } },
  },
  {
    name: "a wildcard move creates the target in each element",
    why: "Creating a slot per element is where a naive implementation goes wrong.",
    instrs: [{ k: "move", from: "/data/*/amount_cents", to: "/data/*/amount", c: C }],
    input: { data: [{ amount_cents: 100 }, { amount_cents: 250 }] },
    expect: { output: { data: [{ amount: 100 }, { amount: 250 }] } },
  },
  {
    name: "cast turns a number into a string",
    why: "Some contracts carry identifiers as one and some as the other.",
    instrs: [{ k: "cast", path: "/id", to: "string", c: C }],
    input: { id: 42 },
    expect: { output: { id: "42" } },
  },
  {
    name: "time writes epoch seconds as RFC 3339 in UTC",
    why: "The commonest date change there is, and the output text is fixed: UTC, no fraction when it is zero.",
    instrs: [{ k: "time", path: "/created", from: "epoch-s", to: "rfc3339", c: C }],
    input: { created: 1700000000 },
    expect: { output: { created: "2023-11-14T22:13:20Z" } },
  },
  {
    name: "time reads an offset as the instant it names",
    why: "An offset is part of the text, not of the instant, so it moves the count and nothing else.",
    instrs: [{ k: "time", path: "/created", from: "rfc3339", to: "epoch-s", c: C }],
    input: { created: "2023-11-15T00:13:20+02:00" },
    expect: { output: { created: 1700000000 } },
  },
  {
    name: "time keeps milliseconds as three digits",
    why: "Whether the fraction is written, and how long it is, has to be the same in every engine.",
    instrs: [{ k: "time", path: "/at", from: "epoch-ms", to: "rfc3339", c: C }],
    input: { at: 1700000000120 },
    expect: { output: { at: "2023-11-14T22:13:20.120Z" } },
  },
  {
    name: "time before 1970 and in the first century",
    why: "Negative counts and years below 100 are where library date functions differ, so neither is used.",
    instrs: [
      { k: "time", path: "/a", from: "epoch-s", to: "rfc3339", c: C },
      { k: "time", path: "/b", from: "rfc3339", to: "epoch-s", c: C },
    ],
    input: { a: -1, b: "0099-03-01T00:00:00Z" },
    expect: { output: { a: "1969-12-31T23:59:59Z", b: -59037897600 } },
  },
  {
    name: "time refuses a fraction of a second going to whole seconds",
    why: "Truncating would move the instant, and nobody asked for that.",
    instrs: [{ k: "time", path: "/at", from: "rfc3339", to: "epoch-s", c: C }],
    input: { at: "2023-11-14T22:13:20.5Z" },
    expect: { refuses: C },
  },
  {
    name: "time refuses a leap second",
    why: "The epoch has no count for 23:59:60, and folding it into the next second is a guess.",
    instrs: [{ k: "time", path: "/at", from: "rfc3339", to: "epoch-ms", c: C }],
    input: { at: "2016-12-31T23:59:60Z" },
    expect: { refuses: C },
  },
  {
    name: "time refuses a day that does not exist",
    why: "A lenient parser rolls 29 February 2023 into March; this one refuses it.",
    instrs: [{ k: "time", path: "/at", from: "rfc3339", to: "epoch-s", c: C }],
    input: { at: "2023-02-29T00:00:00Z" },
    expect: { refuses: C },
  },
  {
    name: "time refuses a year RFC 3339 cannot write",
    why: "Four digits of year is all the format has.",
    instrs: [{ k: "time", path: "/at", from: "epoch-s", to: "rfc3339", c: C }],
    input: { at: 253402300800 },
    expect: { refuses: C },
  },
  {
    name: "time leaves null alone",
    why: "A nullable instant stays nullable in every format.",
    instrs: [{ k: "time", path: "/at", from: "epoch-s", to: "rfc3339", c: C }],
    input: { at: null },
    expect: { output: { at: null } },
  },
  {
    name: "case rewrites each word",
    why: "`in_progress` is `IN_PROGRESS` or `inProgress`, and every engine has to agree which.",
    instrs: [
      { k: "case", path: "/a", from: "snake", to: "screaming", c: C },
      { k: "case", path: "/b", from: "snake", to: "camel", c: C },
      { k: "case", path: "/c", from: "kebab", to: "pascal", c: C },
    ],
    input: { a: "in_progress", b: "v2_beta", c: "past-due" },
    expect: { output: { a: "IN_PROGRESS", b: "v2Beta", c: "PastDue" } },
  },
  {
    name: "case refuses words the target cannot keep apart",
    why: "`a_1b` in camel case is `a1b`, which reads back as one word.",
    instrs: [{ k: "case", path: "/a", from: "snake", to: "camel", c: C }],
    input: { a: "a_1b" },
    expect: { refuses: C },
  },
  {
    name: "case refuses an acronym",
    why: "`userID` could be `user_id` or `user_i_d`; neither is a guess to make for someone.",
    instrs: [{ k: "case", path: "/a", from: "camel", to: "snake", c: C }],
    input: { a: "userID" },
    expect: { refuses: C },
  },
  {
    name: "case refuses text not written in the case it names",
    why: "A value that is not an identifier in the old convention is not one this op describes.",
    instrs: [{ k: "case", path: "/a", from: "snake", to: "screaming", c: C }],
    input: { a: "In_progress" },
    expect: { refuses: C },
  },
  {
    name: "wrap puts each value in a list of one",
    why: "A field that became a list, at every element of a list.",
    instrs: [{ k: "wrap", path: "/data/*/email", c: C }],
    input: { data: [{ email: "a@x.io" }, {}, { email: null }] },
    expect: { output: { data: [{ email: ["a@x.io"] }, {}, { email: null }] } },
  },
  {
    name: "unwrap shows the one item",
    why: "The inverse, for an old caller whose contract has the single value.",
    instrs: [{ k: "unwrap", path: "/email", c: C }],
    input: { email: ["a@x.io"] },
    expect: { output: { email: "a@x.io" } },
  },
  {
    name: "unwrap refuses a list of two",
    why: "Showing the first would hide the second from a caller who cannot ask for it.",
    instrs: [{ k: "unwrap", path: "/email", c: C }],
    input: { email: ["a@x.io", "b@x.io"] },
    expect: { refuses: C },
  },
  {
    name: "unwrap first shows the first of several, and leaves an empty list out",
    why:
      "A provider may declare that one item stands for the list. Where there is " +
      "none, the field is left out rather than shown as something it is not.",
    instrs: [{ k: "unwrap", path: "/data/*/email", first: true, c: C }],
    input: { data: [{ email: ["a@x.io", "b@x.io"] }, { email: [] }, { id: 1 }] },
    expect: { output: { data: [{ email: "a@x.io" }, {}, { id: 1 }] } },
  },
  {
    name: "unwrap refuses an empty list",
    why: "The old contract has a value there and cannot say there is none.",
    instrs: [{ k: "unwrap", path: "/email", c: C }],
    input: { email: [] },
    expect: { refuses: C },
  },
  {
    name: "drop takes the values out of a list and keeps the rest in order",
    why:
      "Asana stopped offering fields an old caller could ask for in opt_fields; " +
      "the request goes on with everything else it asked for.",
    instrs: [{ k: "drop", path: "/opt_fields", values: ["color", "archived"], c: C }],
    input: { opt_fields: ["name", "color", "owner", "archived", "color"] },
    expect: { output: { opt_fields: ["name", "owner"] } },
  },
  {
    name: "drop leaves an empty list where every value was dropped, and a list without them alone",
    why: "The caller sent a list, so a list goes on; one with nothing to drop is not touched.",
    instrs: [{ k: "drop", path: "/lists/*", values: ["color"], c: C }],
    input: { lists: [["color"], ["name", 7, null]] },
    expect: { output: { lists: [[], ["name", 7, null]] } },
  },
  {
    name: "drop refuses a single value",
    why: "A single value that is gone has no request left without it.",
    instrs: [{ k: "drop", path: "/opt_fields", values: ["color"], c: C }],
    input: { opt_fields: "color" },
    expect: { refuses: C },
  },
  {
    name: "instructions apply in order",
    why:
      "A rename followed by a conversion targets the new name. Applying them " +
      "in any other order finds nothing and silently does half the work.",
    instrs: [
      { k: "move", from: "/amount", to: "/amount_cents", c: C },
      { k: "scale", path: "/amount_cents", exp: 2, c: C },
    ],
    input: { amount: 19.99 },
    expect: { output: { amount_cents: 1999 } },
  },
  {
    name: "a wildcard at the cap transforms every element",
    why: "The cap is a ceiling, not a sample: a body within it is transformed whole.",
    maxMatches: 3,
    instrs: [{ k: "move", from: "/data/*/amount", to: "/data/*/amount_cents", c: C }],
    input: { data: [{ amount: 1 }, { amount: 2 }, { amount: 3 }] },
    expect: {
      output: { data: [{ amount_cents: 1 }, { amount_cents: 2 }, { amount_cents: 3 }] },
    },
  },
  {
    name: "a wildcard past the cap at the end of a path is refused",
    why:
      "Transforming the first N elements and leaving the rest is a body in the " +
      "wrong shape that nothing reports. It is refused whole instead.",
    maxMatches: 3,
    instrs: [{ k: "enum", path: "/tags/*", map: { old: "new" }, c: C }],
    input: { tags: ["old", "old", "old", "old"] },
    expect: { refuses: C },
  },
  {
    name: "a wildcard past the cap in the middle of a path is refused",
    why:
      "Dropping every match here would skip the instruction entirely, which is " +
      "the same silent wrong shape. It is refused whole instead.",
    maxMatches: 3,
    instrs: [{ k: "scale", path: "/data/*/amount", exp: 2, c: C }],
    input: { data: [{ amount: 1 }, { amount: 2 }, { amount: 3 }, { amount: 4 }] },
    expect: { refuses: C },
  },
  {
    name: "within runs a block at every element of a list",
    why: "A Change to one element of a list is written once, relative to the element.",
    instrs: [
      {
        k: "within",
        path: "/data/*",
        block: [{ k: "move", from: "/a", to: "/b", c: C }],
        c: C,
      },
    ],
    input: { data: [{ a: 1 }, { a: 2 }, "not an object"] },
    expect: { output: { data: [{ b: 1 }, { b: 2 }, "not an object"] } },
  },
  {
    name: "within reaches a value that is not an object, and an empty path rewrites it",
    why:
      "A named vocabulary held where null is allowed too, as `anyOf: [Method, null]`, is " +
      "reached by a within guarded on its type. Skipping a scalar there would leave " +
      "every nullable use of the vocabulary unconverted while the plain uses are.",
    instrs: [
      {
        k: "within",
        path: "/methods/*",
        block: [
          {
            k: "is",
            path: "",
            type: "string",
            block: [
              { k: "case", path: "", from: "screaming", to: "snake", c: C },
              { k: "enum", path: "", map: { get: "fetch", post: "send" }, c: C },
            ],
            c: C,
          },
        ],
        c: C,
      },
    ],
    input: { methods: ["GET", null, "POST"] },
    expect: { output: { methods: ["fetch", null, "send"] } },
  },
  {
    name: "switch runs only the block for the variant the key names",
    why:
      "A Change to one variant of a union must not touch the others, which may " +
      "have a field of the same name meaning something else.",
    instrs: [
      {
        k: "within",
        path: "/methods/*",
        block: [
          {
            k: "switch",
            path: "/type",
            cases: { scheme: [{ k: "move", from: "/number", to: "/card_number", c: C }] },
            c: C,
          },
        ],
        c: C,
      },
    ],
    input: {
      methods: [
        { type: "scheme", number: "4111" },
        { type: "ideal", number: "NL01" },
        { number: "no type" },
      ],
    },
    expect: {
      output: {
        methods: [
          { type: "scheme", card_number: "4111" },
          { type: "ideal", number: "NL01" },
          { number: "no type" },
        ],
      },
    },
  },
  {
    name: "switch reads its key once, before the block can change it",
    why: "Which variant a value is must not depend on what the block does to it.",
    instrs: [
      {
        k: "switch",
        path: "/type",
        cases: {
          card: [
            { k: "enum", path: "/type", map: { card: "scheme" }, c: C },
            { k: "set", path: "/converted", value: true, ifAbsent: false, c: C },
          ],
          scheme: [{ k: "set", path: "/wrong", value: true, ifAbsent: false, c: C }],
        },
        c: C,
      },
    ],
    input: { type: "card" },
    expect: { output: { type: "scheme", converted: true } },
  },
  {
    name: "switch on a number or a boolean matches its text",
    why: "A discriminator is not always a string.",
    instrs: [
      {
        k: "switch",
        path: "/version",
        cases: { "2": [{ k: "del", path: "/legacy", c: C }] },
        c: C,
      },
    ],
    input: { version: 2, legacy: "x" },
    expect: { output: { version: 2 } },
  },
  {
    name: "has runs its block only where the field is present",
    why: "A union told apart by which field it has, rather than by a key's value.",
    instrs: [
      {
        k: "has",
        path: "/card",
        block: [{ k: "del", path: "/card/cvc", c: C }],
        c: C,
      },
    ],
    input: { card: { number: "4111", cvc: "123" } },
    expect: { output: { card: { number: "4111" } } },
  },
  {
    name: "has with absent runs its block only where a field is missing",
    why:
      "Stripe's live and deleted objects share their type and differ only in " +
      "that the deleted one carries `deleted`; the live one is known by its absence.",
    instrs: [
      {
        k: "within",
        path: "/data/*",
        block: [
          {
            k: "has",
            path: "/deleted",
            absent: true,
            block: [{ k: "move", from: "/amount", to: "/amount_off", c: C }],
            c: C,
          },
        ],
        c: C,
      },
    ],
    input: { data: [{ amount: 5 }, { amount: 5, deleted: true }] },
    expect: { output: { data: [{ amount_off: 5 }, { amount: 5, deleted: true }] } },
  },
  {
    name: "an object a within reached becomes its own id",
    why:
      "A union gained a kind of object old callers never heard of. Stripe sends " +
      "the id of an object a caller did not expand, and the old union allows it.",
    instrs: [
      {
        k: "within",
        path: "/data/*",
        block: [
          {
            k: "switch",
            path: "/object",
            cases: { terminal: [{ k: "move", from: "/id", to: "", c: C }] },
            c: C,
          },
        ],
        c: C,
      },
    ],
    input: {
      data: [
        { object: "card", id: "card_1" },
        { object: "terminal", id: "tm_1" },
        "src_1",
      ],
    },
    expect: { output: { data: [{ object: "card", id: "card_1" }, "tm_1", "src_1"] } },
  },
  {
    name: "list items a within reached are removed, however many",
    why:
      "Removing an item shifts the ones after it. Every one chosen has to go, " +
      "and no other, whatever order they were found in.",
    instrs: [
      {
        k: "within",
        path: "/data/*",
        block: [
          { k: "has", path: "/deleted", block: [{ k: "del", path: "", c: C }], c: C },
        ],
        c: C,
      },
    ],
    input: {
      data: [
        { id: "a" },
        { id: "b", deleted: true },
        { id: "c" },
        { id: "d", deleted: true },
      ],
    },
    expect: { output: { data: [{ id: "a" }, { id: "c" }] } },
  },
  {
    name: "a value a within reached is replaced with null",
    why: "Where old callers could be sent null, a value they cannot read becomes one.",
    instrs: [
      {
        k: "within",
        path: "/customer",
        block: [{ k: "set", path: "", value: null, ifAbsent: false, c: C }],
        c: C,
      },
    ],
    input: { customer: { object: "account", id: "acct_1" } },
    expect: { output: { customer: null } },
  },
  {
    name: "an instruction that would replace a whole body is refused",
    why: "Only a value inside a body can be replaced; a body is what the caller sent.",
    instrs: [{ k: "move", from: "/id", to: "", c: C }],
    input: { id: "x" },
    expect: { refuses: "decode" },
  },
  {
    name: "a map wildcard reaches every value of an object",
    why:
      "A price table keyed by currency, or metadata keyed by whatever the " +
      "caller chose: the keys are data, and a Change reaches each value.",
    instrs: [
      { k: "move", from: "/prices/{}/amount", to: "/prices/{}/unit_amount", c: C },
    ],
    input: { prices: { usd: { amount: 100 }, eur: { amount: 90 } } },
    expect: {
      output: { prices: { usd: { unit_amount: 100 }, eur: { unit_amount: 90 } } },
    },
  },
  {
    name: "a move between maps keeps each value under its own key",
    why: "Each map wildcard on the left lines up with one on the right, key by key.",
    instrs: [{ k: "move", from: "/limits/{}", to: "/quotas/{}", c: C }],
    input: { limits: { reads: 10, writes: 2 } },
    expect: { output: { quotas: { reads: 10, writes: 2 } } },
  },
  {
    name: "a move from a list to a map is refused",
    why: "A list index is not a key, so there is no telling where each value goes.",
    instrs: [{ k: "move", from: "/items/*/id", to: "/byId/{}", c: C }],
    input: {},
    expect: { refuses: "decode" },
  },
  {
    name: "a map wildcard passes over a key that would reach a prototype",
    why: "A body's keys are the caller's; one named __proto__ is never followed.",
    instrs: [{ k: "set", path: "/metadata/{}/seen", value: true, ifAbsent: false, c: C }],
    input: JSON.parse('{"metadata":{"a":{},"__proto__":{}}}') as unknown,
    expect: {
      output: JSON.parse('{"metadata":{"a":{"seen":true},"__proto__":{}}}') as unknown,
    },
  },
  {
    name: "a key read through a wildcard is refused",
    why: "A key is one value at one place; a wildcard would make it several.",
    instrs: [{ k: "switch", path: "/data/*/type", cases: {}, c: C }],
    input: {},
    expect: { refuses: "decode" },
  },
  {
    name: "blocks nested past the limit are refused",
    why: "Each level multiplies how many places one instruction reaches.",
    instrs: [
      Array.from({ length: 9 }).reduce<unknown>(
        (inner) => ({ k: "within", path: "/a", block: [inner], c: C }),
        { k: "del", path: "/x", c: C },
      ) as never,
    ],
    input: {},
    expect: { refuses: "decode" },
  },
  {
    name: "a program naming a prototype key is refused",
    why:
      "`__proto__` reaches an object every other object shares. A program is " +
      "data from a build, and a build can be wrong; this must not be reachable.",
    instrs: [{ k: "set", path: "/__proto__/polluted", value: 1, ifAbsent: false, c: C }],
    input: {},
    expect: { refuses: "decode" },
  },
  {
    name: "call runs a named block where it stands",
    why: "A block shared by every place a schema sits runs as if written at the call.",
    blocks: { Payment: [{ k: "del", path: "/secret", c: C }] },
    instrs: [{ k: "call", block: "Payment", c: C }],
    input: { id: "pay_1", secret: "x" },
    expect: { output: { id: "pay_1" } },
  },
  {
    name: "a block calls itself to follow a tree to its leaves",
    why:
      "A schema that contains itself has no last place to list. The block " +
      "descends and calls itself, so every level is translated, however deep.",
    blocks: {
      Node: [
        { k: "move", from: "/name", to: "/title", c: C },
        {
          k: "within",
          path: "/children/*",
          block: [{ k: "call", block: "Node", c: C }],
          c: C,
        },
      ],
    },
    instrs: [{ k: "call", block: "Node", c: C }],
    input: {
      name: "root",
      children: [{ name: "a", children: [{ name: "a1", children: [] }] }, { name: "b" }],
    },
    expect: {
      output: {
        title: "root",
        children: [
          { title: "a", children: [{ title: "a1", children: [] }] },
          { title: "b" },
        ],
      },
    },
  },
  {
    name: "is runs its block only where a value is of one kind",
    why:
      "Stripe's expandable fields hold an id or the whole object. Only the " +
      "object has fields to translate; the id passes untouched.",
    instrs: [
      {
        k: "within",
        path: "/data/*",
        block: [
          {
            k: "is",
            path: "/customer",
            type: "object",
            block: [
              { k: "move", from: "/customer/name", to: "/customer/full_name", c: C },
            ],
            c: C,
          },
        ],
        c: C,
      },
    ],
    input: { data: [{ customer: "cus_1" }, { customer: { name: "Ada" } }, {}] },
    expect: {
      output: { data: [{ customer: "cus_1" }, { customer: { full_name: "Ada" } }, {}] },
    },
  },
  {
    name: "is tells a number however it was written",
    why: "A number is a number whether or not it is kept as its exact digits.",
    instrs: [
      {
        k: "is",
        path: "/amount",
        type: "number",
        block: [{ k: "set", path: "/numeric", value: true, ifAbsent: false, c: C }],
        c: C,
      },
    ],
    input: { amount: 10.5 },
    expect: { output: { amount: 10.5, numeric: true } },
  },
  {
    name: "a call to a block the contract does not have is refused",
    why: "A program naming instructions it does not carry cannot be run as written.",
    instrs: [{ k: "call", block: "Missing", c: C }],
    input: {},
    expect: { refuses: "decode" },
  },
  {
    name: "blocks that call one another without descending are refused",
    why:
      "A call runs where it stands, so a cycle that never moves into the " +
      "value would never end. Only recursion that follows the value is allowed.",
    blocks: {
      A: [{ k: "has", path: "/x", block: [{ k: "call", block: "B", c: C }], c: C }],
      B: [{ k: "call", block: "A", c: C }],
    },
    instrs: [{ k: "call", block: "A", c: C }],
    input: { x: 1 },
    expect: { refuses: "decode" },
  },
  {
    name: "a contract calls the program's blocks, which call one another",
    why:
      "A chain of contracts is linked, not written out: each contract's work " +
      "ends in a call to the next contract's, held at the top of the program. " +
      "An engine that only looked up a contract's own blocks could not run it.",
    programBlocks: {
      "v2>0": [
        { k: "move", from: "/amount", to: "/amount_cents", c: C },
        { k: "call", block: "v3>0", c: C },
      ],
      "v3>0": [
        { k: "move", from: "/amount_cents", to: "/amount_minor", c: C },
        { k: "set", path: "/currency", value: "usd", ifAbsent: true, c: C },
      ],
    },
    instrs: [
      { k: "move", from: "/total", to: "/amount", c: C },
      { k: "call", block: "v2>0", c: C },
    ],
    input: { total: 100 },
    expect: { output: { amount_minor: 100, currency: "usd" } },
  },
  {
    name: "a contract may not declare a block the program already does",
    why:
      "One name meaning two things depending on who calls it is a program " +
      "that runs differently on engines that resolve it differently.",
    programBlocks: { Shared: [{ k: "del", path: "/a", c: C }] },
    blocks: { Shared: [{ k: "del", path: "/b", c: C }] },
    instrs: [{ k: "call", block: "Shared", c: C }],
    input: { a: 1, b: 2 },
    expect: { refuses: "decode" },
  },
];
