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
import type { Instr } from "@invariant/ir";

export interface Vector {
  name: string;
  /** Why this case is in the list at all. */
  why: string;
  instrs: Instr[];
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
];
