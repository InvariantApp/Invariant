/**
 * XML bodies against the golden vectors, and the properties the vectors can
 * only sample: that a document nothing changes is written back byte for byte,
 * and that no body, however hostile, makes the codec do anything but answer
 * or refuse.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BodyTooLargeError } from "./errors.ts";
import { createRuntime } from "./index.ts";
import { TransformError } from "./interpreter.ts";
import { XmlBodyError } from "./xml.ts";
import { XML_VECTORS, type XmlVector } from "./xml-vectors.ts";

function run(vector: Pick<XmlVector, "xml" | "instrs" | "input">): {
  output?: string;
  refusedBy?: string;
} {
  let runtime: ReturnType<typeof createRuntime>;
  try {
    runtime = createRuntime({
      program: {
        irVersion: 2,
        api: "conformance",
        current: "sha256:0",
        currentLabel: "current",
        contracts: {
          old: {
            label: "old",
            routes: [],
            sites: {
              "post /v": { xml: { request: vector.xml }, request: vector.instrs },
            },
            behaviors: [],
            retired: [],
          },
        },
      },
      identity: [{ kind: "default", label: "old" }],
    });
  } catch {
    return { refusedBy: "decode" };
  }
  const site = runtime.siteFor("old", "post", "/v");
  if (!site) throw new Error("no site");
  try {
    return {
      output: runtime.transformRequestXml(site, vector.input, {
        contract: "old",
        operation: "v",
      }),
    };
  } catch (error) {
    if (error instanceof TransformError) return { refusedBy: error.changeId };
    if (error instanceof XmlBodyError) return { refusedBy: "body" };
    if (error instanceof BodyTooLargeError) return { refusedBy: "too-large" };
    return { refusedBy: `error: ${(error as Error).message}` };
  }
}

describe("the XML vectors", () => {
  for (const vector of XML_VECTORS) {
    it(vector.name, () => {
      const result = run(vector);
      if ("refuses" in vector.expect)
        expect(result.refusedBy).toBe(vector.expect.refuses);
      else {
        expect(result.refusedBy).toBeUndefined();
        expect(result.output).toBe(vector.expect.output);
      }
    });
  }
});

/** CloudFront's distribution config, cut to one field whose vocabulary grew. */
const config = {
  read: {
    type: "object",
    properties: {
      ViewerCertificate: {
        type: "object",
        properties: { MinimumProtocolVersion: { type: "string" } },
      },
    },
  },
  write: {
    type: "object",
    properties: {
      ViewerCertificate: {
        type: "object",
        properties: { MinimumProtocolVersion: { type: "string" } },
      },
    },
  },
} as const;

function cloudfront() {
  return createRuntime({
    program: {
      irVersion: 2,
      api: "cloudfront",
      current: "sha256:0",
      currentLabel: "2020-05-31",
      contracts: {
        "2019-03-26": {
          label: "2019-03-26",
          routes: [],
          sites: {
            "put /distribution/{Id}/config": {
              xml: { request: config, response: { "200": config } },
              request: [
                {
                  k: "enum",
                  path: "/ViewerCertificate/MinimumProtocolVersion",
                  map: { TLSv1: "TLSv1", "TLSv1.1_2016": "TLSv1.1_2016" },
                  c: "chg_tls",
                },
              ],
              response: {
                "200": [
                  {
                    k: "enum",
                    path: "/ViewerCertificate/MinimumProtocolVersion",
                    map: {
                      TLSv1: "TLSv1",
                      "TLSv1.1_2016": "TLSv1.1_2016",
                      "TLSv1.2_2019": "TLSv1.1_2016",
                    },
                    folded: ["TLSv1.2_2019"],
                    c: "chg_tls",
                  },
                ],
              },
            },
          },
          behaviors: [],
          retired: [],
        },
      },
    },
    identity: [{ kind: "default", label: "2019-03-26" }],
  });
}

const DOCUMENT = (version: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<DistributionConfig xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">\n  <CallerReference>ref</CallerReference>\n  <ViewerCertificate>\n    <MinimumProtocolVersion>${version}</MinimumProtocolVersion>\n  </ViewerCertificate>\n</DistributionConfig>\n`;

describe("an XML answer on its way to an old caller", () => {
  const context = { contract: "2019-03-26", operation: "UpdateDistribution" };

  it("is shown a value its contract names in place of one it does not, and told so", async () => {
    const runtime = cloudfront();
    const site = runtime.siteFor("2019-03-26", "put", "/distribution/E1/config");
    const response = await runtime.adaptResponse(
      site,
      new Response(DOCUMENT("TLSv1.2_2019"), {
        status: 200,
        headers: { "content-type": "text/xml", etag: '"E2"' },
      }),
      context,
      { encoded: false, method: "PUT" },
    );
    expect(await response.text()).toBe(DOCUMENT("TLSv1.1_2016"));
    expect(response.headers.get("invariant-folded")).toBe(
      "ViewerCertificate/MinimumProtocolVersion",
    );
    expect(response.headers.get("etag")).not.toBe('"E2"');
  });

  it("passes on untouched, byte for byte, when nothing in it changes", async () => {
    const runtime = cloudfront();
    const site = runtime.siteFor("2019-03-26", "put", "/distribution/E1/config");
    const response = await runtime.adaptResponse(
      site,
      new Response(DOCUMENT("TLSv1"), {
        status: 200,
        headers: { "content-type": "application/xml; charset=UTF-8", etag: '"E2"' },
      }),
      context,
      { encoded: false, method: "PUT" },
    );
    expect(await response.text()).toBe(DOCUMENT("TLSv1"));
    expect(response.headers.get("etag")).toBe('"E2"');
  });

  it("becomes the provider's error, never the untranslated body, when it cannot be read", async () => {
    const runtime = cloudfront();
    const site = runtime.siteFor("2019-03-26", "put", "/distribution/E1/config");
    const response = await runtime.adaptResponse(
      site,
      new Response('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>', {
        status: 200,
        headers: { "content-type": "text/xml" },
      }),
      context,
      { encoded: false, method: "PUT" },
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("invariant_response_not_translatable");
  });

  it("is refused in a charset it was not read in", async () => {
    const runtime = cloudfront();
    const site = runtime.siteFor("2019-03-26", "put", "/distribution/E1/config");
    const response = await runtime.adaptResponse(
      site,
      new Response(DOCUMENT("TLSv1"), {
        status: 200,
        headers: { "content-type": "text/xml; charset=ISO-8859-1" },
      }),
      context,
      { encoded: false, method: "PUT" },
    );
    expect(response.status).toBe(502);
  });
});

describe("an XML request from an old caller", () => {
  it("is read as the operation describes it, and anything else passes as it came", async () => {
    const runtime = cloudfront();
    const site = runtime.siteFor("2019-03-26", "put", "/distribution/E1/config");
    if (!site) throw new Error("no site");
    const parts = { path: "/distribution/E1/config", search: "", headers: new Headers() };
    const context = { contract: "2019-03-26", operation: "UpdateDistribution" };
    const xml = await runtime.adaptRequest(
      site,
      new Request("http://x.invalid/distribution/E1/config", {
        method: "PUT",
        headers: { "content-type": "text/xml" },
        body: DOCUMENT("TLSv1"),
      }),
      { ...parts, headers: new Headers({ "content-type": "text/xml" }) },
      context,
    );
    expect(xml.body).toBe(DOCUMENT("TLSv1"));
    await expect(
      runtime.adaptRequest(
        site,
        new Request("http://x.invalid/distribution/E1/config", {
          method: "PUT",
          headers: { "content-type": "text/xml" },
          body: DOCUMENT("SSLv3"),
        }),
        { ...parts, headers: new Headers({ "content-type": "text/xml" }) },
        context,
      ),
    ).rejects.toThrow(/No mapping for "SSLv3"/);
    const csv = await runtime.adaptRequest(
      site,
      new Request("http://x.invalid/distribution/E1/config", {
        method: "PUT",
        headers: { "content-type": "text/csv" },
        body: "a,b",
      }),
      { ...parts, headers: new Headers({ "content-type": "text/csv" }) },
      context,
    );
    expect(csv.body).not.toBeTypeOf("string");
  });
});

/** Documents of elements, attributes, text, comments and CDATA, well formed by construction. */
const NAMES = ["A", "B", "S", "Items", "p:Q"];
const textArb = fc.string({
  unit: fc.constantFrom("a", " ", "&", "<", ">", "\n", "é", '"'),
});
const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const elementArb: fc.Memo<string> = fc.memo((depth) =>
  fc
    .tuple(
      fc.constantFrom(...NAMES),
      fc.array(fc.tuple(fc.constantFrom("id", "kind", "x:y"), textArb), { maxLength: 2 }),
      depth <= 1
        ? fc.array(textArb.map(escaped), { maxLength: 1 })
        : fc.array(
            fc.oneof(
              elementArb(depth - 1),
              fc.constantFrom("\n  ", "<!-- c -->", "<?pi x?>", "<![CDATA[<z>]]>"),
            ),
            { maxLength: 4 },
          ),
    )
    .map(([name, attributes, children]) => {
      const seen = new Set<string>();
      const written = attributes
        .filter(([key]) => !seen.has(key) && seen.add(key))
        .map(([key, value]) => ` ${key}="${escaped(value).replace(/"/g, "&quot;")}"`)
        .join("");
      return children.length === 0
        ? `<${name}${written}/>`
        : `<${name}${written}>${children.join("")}</${name}>`;
    }),
);
const documentArb = elementArb(4).map(
  (root) => `<Doc xmlns:p="urn:p" xmlns:x="urn:x">${root}</Doc>`,
);

/** Every description of the fields the documents use, each read without changing anything. */
const described = {
  read: {
    type: "object",
    properties: {
      A: { type: "object", properties: { S: { type: "string" } } },
      B: { type: "array", items: { type: "object", name: "B" } },
      Items: { type: "array", wrapped: true, items: { type: "string", name: "S" } },
    },
  },
  write: { type: "object" },
} as const;
const reading = [
  { k: "has", path: "/A", block: [{ k: "has", path: "/S", block: [], c: "c" }], c: "c" },
  { k: "within", path: "/B/*", block: [], c: "c" },
  { k: "within", path: "/Items/*", block: [], c: "c" },
] as const;

describe("an XML body, whatever it holds", () => {
  it("comes out byte for byte when the instructions change nothing, or is refused", () => {
    fc.assert(
      fc.property(documentArb, (document) => {
        const result = run({
          xml: described as never,
          instrs: reading as never,
          input: document,
        });
        if (result.refusedBy === undefined) expect(result.output).toBe(document);
        else expect(result.refusedBy).toBe("body");
      }),
      { numRuns: 300 },
    );
  });

  it("is answered or refused with a typed error, never anything else", () => {
    const alphabet = fc.constantFrom(
      "<",
      ">",
      "/",
      "!",
      "?",
      "&",
      ";",
      "#",
      "x",
      "=",
      '"',
      "'",
      " ",
      "\n",
      "S",
      "A",
      "[",
      "]",
      "-",
      "C",
      "D",
      "T",
      ":",
      "p",
      "\u0000",
      "\uD800",
      "é",
    );
    fc.assert(
      fc.property(fc.string({ unit: alphabet, maxLength: 80 }), (input) => {
        const result = run({
          xml: described as never,
          instrs: [{ k: "set", path: "/A/S", value: "v", ifAbsent: false, c: "c" }],
          input: `<Doc>${input}</Doc>`,
        });
        expect(
          result.refusedBy === undefined ||
            ["body", "too-large", "c"].includes(result.refusedBy),
        ).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("is well formed after any change, and reads back as what was written", () => {
    fc.assert(
      fc.property(documentArb, textArb, (document, value) => {
        const result = run({
          xml: {
            read: described.read as never,
            write: {
              type: "object",
              properties: {
                A: { type: "object", properties: { S: { type: "string" } } },
              },
            },
          },
          instrs: [{ k: "set", path: "/A/S", value, ifAbsent: false, c: "c" }],
          input: document,
        });
        if (result.output === undefined) return;
        const back = run({
          xml: described as never,
          instrs: [
            {
              k: "enum",
              path: "/A/S",
              map: { [value.replace(/\r\n?/g, "\n")]: "same" },
              c: "c",
            },
          ],
          input: result.output,
        });
        expect(back.refusedBy).toBeUndefined();
      }),
      { numRuns: 300 },
    );
  });
});
