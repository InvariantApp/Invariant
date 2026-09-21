/**
 * Rig F: the runtime, against input chosen to break it.
 *
 * The runtime sits in the path of every request a provider serves, so a
 * crash, a hang or an untyped exception there is an outage rather than a bug
 * report. Each property states what the runtime promises for any input at
 * all: it returns, or it refuses with one of its own typed errors, and it
 * never changes anything it was not asked to.
 *
 * Every commit runs a small budget; the nightly run raises it with FUZZ_RUNS
 * and a fresh seed, printed so a failure can be replayed exactly:
 *
 *   FUZZ_RUNS=200000 FUZZ_SEED=123 pnpm vitest run proving/fuzz
 *
 * A counterexample is kept as a regression test beside the code it broke.
 */
import { readFileSync } from "node:fs";
import {
  BodyTooLargeError,
  createRuntime,
  decodeProgram,
  MatchLimitError,
  matchTemplate,
  ProgramError,
  TransformError,
} from "@invariant/runtime";
import { createProxy } from "@invariant/sidecar";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const RUNS = Number(process.env["FUZZ_RUNS"] ?? 300);
const SEED =
  process.env["FUZZ_SEED"] === undefined ? undefined : Number(process.env["FUZZ_SEED"]);
const settings = { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: SEED }) };
if (SEED === undefined && RUNS > 1000) {
  // A deep run with no seed given picks one, and says which.
  console.log(`fuzzing with fast-check's own seed; set FUZZ_SEED to replay`);
}

interface Vector {
  name: string;
  instrs: unknown[];
  blocks?: Record<string, unknown[]>;
  programBlocks?: Record<string, unknown[]>;
  expect: { output?: unknown; refuses?: string };
  maxMatches?: number;
}

const VECTORS = (
  JSON.parse(
    readFileSync(new URL("../../conformance/vectors.json", import.meta.url), "utf8"),
  ) as { vectors: Vector[] }
).vectors;

function programWith(
  instrs: unknown[],
  blocks: Pick<Vector, "blocks" | "programBlocks"> = {},
): unknown {
  return {
    irVersion: 2,
    api: "fuzz",
    currentLabel: "new",
    current: "sha256:fuzz",
    ...(blocks.programBlocks === undefined ? {} : { blocks: blocks.programBlocks }),
    contracts: {
      old: {
        label: "old",
        routes: [
          {
            from: { method: "post", path: "/v1/{id}:old" },
            to: { method: "post", path: "/v2/{id}:new" },
            c: "chg_route",
          },
        ],
        sites: {
          "post /v2/{id}:new": { request: instrs, response: { "2xx": instrs } },
          "post /fuzz": { request: instrs, response: { "2xx": instrs } },
        },
        ...(blocks.blocks === undefined ? {} : { blocks: blocks.blocks }),
        behaviors: [],
        retired: [{ method: "delete", path: "/v1/{id}", c: "chg_retired" }],
      },
    },
  };
}

/** The vectors whose programs load, each as a runtime. */
const RUNTIMES = VECTORS.flatMap((vector) => {
  try {
    return [
      {
        name: vector.name,
        runtime: createRuntime({
          program: programWith(vector.instrs, vector),
          identity: [{ kind: "default", label: "old" }],
          maxBodyBytes: 64 * 1024,
          limits: { maxMatches: vector.maxMatches ?? 10_000 },
        }),
      },
    ];
  } catch {
    return [];
  }
});

/** Every key a vector's pointers name, so bodies reach the paths programs touch. */
const KEYS = [
  ...new Set(
    JSON.stringify(VECTORS.map((vector) => vector.instrs))
      .match(/"\/[^"]*"/g)
      ?.flatMap((pointer) => pointer.slice(2, -1).split("/"))
      .filter((key) => key !== "" && key !== "*") ?? [],
  ),
  "__proto__",
  "constructor",
  "prototype",
];

const key = fc.oneof(fc.constantFrom(...KEYS), fc.string({ maxLength: 6 }));
const leaf = fc.oneof(
  fc.constantFrom("pending", "done", "review", "usd", "", "0"),
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(1e21, -0, 2 ** 53 + 2, 0.1, 123.456),
  fc.boolean(),
  fc.constant(null),
);
const { body } = fc.letrec((tie) => ({
  body: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.array(tie("body"), { maxLength: 4 }),
    fc.dictionary(key, tie("body"), { maxKeys: 5 }),
  ),
}));

/** Text that is JSON, JSON with the numbers written oddly, or not JSON at all. */
const text = fc.oneof(
  { weight: 6, arbitrary: body.map((value) => JSON.stringify(value)) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        key,
        fc.constantFrom("1e400", "-0.0", "1E-7", "123456789012345678901234567890"),
      )
      .map(([name, number]) => `{"${name}":${number},"amount":${number}}`),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 40 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom("", "{", "[1,", '{"a":1}{"b":2}', "\u0000", "nul"),
  },
);

const typed = (error: unknown): boolean =>
  error instanceof TransformError ||
  error instanceof MatchLimitError ||
  error instanceof BodyTooLargeError ||
  // An unparseable body: the bindings answer it with a 400 or a 502.
  error instanceof SyntaxError;

function prototypeUntouched(): void {
  expect(Object.keys(Object.prototype)).toEqual([]);
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
}

describe("decoding a program", () => {
  it("accepts it or refuses it with a ProgramError, for any JSON at all", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const before = JSON.stringify(value);
        try {
          decodeProgram(value);
        } catch (error) {
          expect(error).toBeInstanceOf(ProgramError);
        }
        expect(JSON.stringify(value)).toBe(before);
        prototypeUntouched();
      }),
      settings,
    );
  });

  it("does the same for a real program with any one value replaced", () => {
    const valid = programWith(VECTORS[0]?.instrs ?? []);
    const paths: (string | number)[][] = [];
    const walk = (node: unknown, at: (string | number)[]) => {
      paths.push(at);
      if (Array.isArray(node)) {
        for (const [index, child] of node.entries()) walk(child, [...at, index]);
      } else if (node && typeof node === "object") {
        for (const [name, child] of Object.entries(node)) walk(child, [...at, name]);
      }
    };
    walk(valid, []);
    fc.assert(
      fc.property(
        fc.constantFrom(...paths.filter((path) => path.length > 0)),
        fc.jsonValue(),
        (path, value) => {
          const program = structuredClone(valid) as Record<string | number, unknown>;
          let node = program as Record<string | number, unknown>;
          for (const step of path.slice(0, -1))
            node = node[step] as Record<string | number, unknown>;
          node[path.at(-1) as string | number] = value;
          try {
            decodeProgram(program);
          } catch (error) {
            expect(error).toBeInstanceOf(ProgramError);
          }
          prototypeUntouched();
        },
      ),
      settings,
    );
  });
});

describe("transforming a body", () => {
  it("returns JSON or refuses with a typed error, for any body and any program", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RUNTIMES),
        text,
        fc.integer({ min: 100, max: 599 }),
        (entry, input, status) => {
          const site = entry.runtime.siteFor("old", "POST", "/fuzz");
          expect(site).toBeDefined();
          if (!site) return;
          const context = { contract: "old", operation: "post /fuzz" };
          for (const run of [
            () => entry.runtime.transformRequest(site, input, context),
            () => entry.runtime.transformResponse(site, status, input, context),
          ]) {
            try {
              const output = run();
              JSON.parse(output);
            } catch (error) {
              if (!typed(error)) throw error;
            }
          }
          prototypeUntouched();
        },
      ),
      settings,
    );
  });

  it("gives the same answer twice", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RUNTIMES), body, (entry, value) => {
        const site = entry.runtime.siteFor("old", "POST", "/fuzz");
        if (!site) return;
        const context = { contract: "old", operation: "post /fuzz" };
        const attempt = () => {
          try {
            return entry.runtime.transformRequest(site, JSON.stringify(value), context);
          } catch (error) {
            return `refused: ${(error as Error).name}`;
          }
        };
        expect(attempt()).toBe(attempt());
      }),
      settings,
    );
  });
});

interface EnvelopeVectorFile {
  template: string;
  envelope: unknown;
  request: { path: string };
}

const ENVELOPES = (
  JSON.parse(
    readFileSync(new URL("../../conformance/vectors.json", import.meta.url), "utf8"),
  ) as { envelopes: EnvelopeVectorFile[] }
).envelopes.flatMap((vector) => {
  try {
    const runtime = createRuntime({
      program: {
        irVersion: 2,
        api: "fuzz",
        currentLabel: "new",
        current: "sha256:fuzz",
        contracts: {
          old: {
            label: "old",
            routes: [],
            sites: { [`post ${vector.template}`]: { envelope: vector.envelope } },
            behaviors: [],
            retired: [],
          },
        },
      },
      identity: [{ kind: "default", label: "old" }],
      maxBodyBytes: 64 * 1024,
    });
    return [{ runtime, path: vector.request.path }];
  } catch {
    return [];
  }
});

/** The pieces a hostile query string, header or cookie is made of. */
const fragment = fc.oneof(
  fc.constantFrom(
    "limit",
    "page_size",
    "tag",
    "tags",
    "filter",
    "where",
    "sort",
    "amount",
    "note",
    "api_version",
    "[",
    "]",
    "%5B",
    "%5D",
    "=",
    "&",
    "+",
    "%",
    "%0D%0A",
    "%E0%A4%A",
    "__proto__",
    "constructor",
    ",",
    "|",
    " ",
    ";",
    "1e400",
    "-0",
    "true",
  ),
  fc.string({ maxLength: 4 }),
);
const wire = fc.array(fragment, { maxLength: 12 }).map((parts) => parts.join(""));
const headerName = fc.constantFrom(
  "X-Page-Size",
  "x-limit",
  "Cookie",
  "cookie",
  "api-version",
  "X-Note",
  "Authorization",
);

describe("rewriting a whole request", () => {
  it("returns a request or refuses with a typed error, and never writes a line break into a header", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ENVELOPES),
        wire,
        fc.array(fc.tuple(headerName, wire), { maxLength: 4 }),
        fc.option(text, { nil: undefined }),
        (entry, search, headers, body) => {
          const site = entry.runtime.siteFor("old", "POST", entry.path);
          expect(site).toBeDefined();
          if (!site) return;
          const request = { path: entry.path, search, headers, body };
          const context = { contract: "old", operation: "post" };
          const attempt = () => {
            try {
              return entry.runtime.transformEnvelope(site, request, context);
            } catch (error) {
              if (!typed(error)) throw error;
              return `refused: ${(error as Error).name}`;
            }
          };
          const first = attempt();
          expect(attempt()).toEqual(first);
          if (typeof first !== "string") {
            const before = new Set(headers.map(([, value]) => value));
            for (const [, value] of first.headers) {
              // A value the caller sent is theirs; one the program wrote is not.
              if (!before.has(value)) expect(value).not.toMatch(/[\r\n]/);
            }
          }
          prototypeUntouched();
        },
      ),
      settings,
    );
  });
});

const FORMS = (
  JSON.parse(
    readFileSync(new URL("../../conformance/vectors.json", import.meta.url), "utf8"),
  ) as { forms: { form: unknown; instrs: unknown[] }[] }
).forms.flatMap((vector) => {
  try {
    const runtime = createRuntime({
      program: {
        irVersion: 2,
        api: "fuzz",
        currentLabel: "new",
        current: "sha256:fuzz",
        contracts: {
          old: {
            label: "old",
            routes: [],
            sites: { "post /form": { form: vector.form, request: vector.instrs } },
            behaviors: [],
            retired: [],
          },
        },
      },
      identity: [{ kind: "default", label: "old" }],
      maxBodyBytes: 64 * 1024,
    });
    return [runtime];
  } catch {
    return [];
  }
});

const formFragment = fc.oneof(
  fc.constantFrom(
    "metadata",
    "items",
    "amount",
    "Status",
    "StatusCallbackEvent",
    "description",
    "[",
    "]",
    "[]",
    "[0]",
    "[__proto__]",
    "=",
    "&",
    "+",
    "%",
    "%5B",
    "%5D",
    "%0D%0A",
    "1e400",
    "-0",
    "abc",
    "__proto__",
    "constructor",
    "[a]".repeat(40),
  ),
  fc.string({ maxLength: 4 }),
);

describe("rewriting a form body", () => {
  it("returns a form or refuses with a typed error, the same way twice", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FORMS),
        fc.array(formFragment, { maxLength: 16 }).map((parts) => parts.join("")),
        (runtime, body) => {
          const site = runtime.siteFor("old", "POST", "/form");
          expect(site).toBeDefined();
          if (!site) return;
          const attempt = () => {
            try {
              return runtime.transformRequestForm(site, body, {
                contract: "old",
                operation: "post /form",
              });
            } catch (error) {
              if (!typed(error)) throw error;
              return `refused: ${(error as Error).name}`;
            }
          };
          expect(attempt()).toBe(attempt());
          prototypeUntouched();
        },
      ),
      settings,
    );
  });
});

describe("matching a path template", () => {
  const literal = fc.stringMatching(/^[a-z0-9._:-]{1,6}$/);
  const segment = fc.oneof(
    literal,
    fc.constant("{id}"),
    fc
      .tuple(literal, fc.constantFrom(":", ".", "-"))
      .map(([word, joint]) => `{p}${joint}${word}`),
    fc
      .tuple(literal, fc.constantFrom(":", "."))
      .map(([word, joint]) => `${word}${joint}{p}`),
  );
  const template = fc
    .array(segment, { minLength: 1, maxLength: 5 })
    .map((parts) => `/${parts.join("/")}`);

  it("fills back to exactly the path it matched", () => {
    fc.assert(
      fc.property(
        template,
        fc.array(fc.stringMatching(/^[A-Za-z0-9_~%-]{1,8}$/), {
          minLength: 5,
          maxLength: 5,
        }),
        (shape, values) => {
          let next = 0;
          const path = shape.replace(/\{[^}]+\}/g, () => values[next++] as string);
          const params = matchTemplate(shape.split("/"), path);
          expect(params).toBeDefined();
          let filled = 0;
          expect(
            shape.replace(/\{[^}]+\}/g, () => (params as string[])[filled++] as string),
          ).toBe(path);
        },
      ),
      settings,
    );
  });

  it("never matches a path with a different number of segments", () => {
    fc.assert(
      fc.property(template, fc.string({ maxLength: 30 }), (shape, path) => {
        const params = matchTemplate(shape.split("/"), path);
        if (params !== undefined)
          expect(path.split("/")).toHaveLength(shape.split("/").length);
      }),
      settings,
    );
  });
});

describe("the proxy", () => {
  const methods = fc.constantFrom(
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  );
  const paths = fc.oneof(
    fc.constantFrom(
      "/fuzz",
      "/v1/abc:old",
      "/v1/abc",
      "/v2/x:new",
      "/",
      "/__invariant/health",
    ),
    fc.stringMatching(/^\/[A-Za-z0-9/%._:~-]{0,30}$/),
  );
  const contentTypes = fc.constantFrom(
    "application/json",
    "application/json; charset=utf-8",
    "application/merge-patch+json",
    "text/plain",
    "application/x-www-form-urlencoded",
    "",
  );
  const encodings = fc.constantFrom(
    undefined,
    "gzip",
    "br",
    "deflate",
    "identity",
    "zstd",
    "gzip, gzip",
  );

  it("always answers, whatever it is sent and whatever the API sends back", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RUNTIMES),
        methods,
        paths,
        contentTypes,
        encodings,
        text,
        fc.integer({ min: 200, max: 599 }),
        encodings,
        text,
        async (
          entry,
          method,
          path,
          type,
          encoding,
          input,
          status,
          upstreamEncoding,
          answer,
        ) => {
          const upstream = (async () =>
            new Response(status === 204 || status === 304 ? null : answer, {
              status,
              headers: {
                "content-type": type || "application/json",
                ...(upstreamEncoding ? { "content-encoding": upstreamEncoding } : {}),
              },
            })) as unknown as typeof fetch;
          const proxy = createProxy({
            runtime: entry.runtime,
            upstream: "http://upstream.test",
            fetch: upstream,
          });
          const hasBody = method !== "GET" && method !== "HEAD";
          const response = await proxy(
            new Request(`http://proxy.test${path}`, {
              method,
              headers: {
                ...(type ? { "content-type": type } : {}),
                ...(encoding ? { "content-encoding": encoding } : {}),
              },
              ...(hasBody ? { body: input } : {}),
            }),
          );
          expect(response.status).toBeGreaterThanOrEqual(200);
          expect(response.status).toBeLessThan(600);
          // An error the proxy produces itself is always a typed one it chose,
          // so a 500 can only be the provider's own, passed through.
          if (response.status === 500) expect(status).toBe(500);
          await response.arrayBuffer();
          prototypeUntouched();
        },
      ),
      { ...settings, numRuns: Math.max(50, Math.floor(RUNS / 3)) },
    );
  });
});
