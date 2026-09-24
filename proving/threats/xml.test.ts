/**
 * XML built to attack whatever reads it.
 *
 * XML carries its own ways in: entities that expand a few hundred bytes into
 * gigabytes, entities that read a file or fetch a URL, and a namespace or
 * attribute count that makes a parser's work grow with the square of the
 * document. The runtime reads XML for Amazon-style APIs in the path of every
 * request, so each is sent here, to the runtime and through a binding, and
 * each has to be refused quickly, without reading anything, and with the
 * refusal a caller is meant to get.
 */
import {
  BodyTooDeepError,
  createRuntime,
  type InvariantRuntime,
  XmlBodyError,
} from "@invariant-app/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recordingUpstream,
  type Sidecar,
  startSidecar,
  type Upstream,
} from "./harness.ts";

const description = {
  read: { type: "object", properties: { S: { type: "string" } } },
  write: { type: "object", properties: { S: { type: "string" } } },
};

/** One operation whose bodies are XML, with a value renamed each way. */
const PROGRAM = {
  irVersion: 2,
  api: "xml",
  current: "sha256:0",
  currentLabel: "new",
  identity: [
    { kind: "header", name: "xml-version" },
    { kind: "default", label: "new" },
  ],
  contracts: {
    old: {
      label: "old",
      routes: [],
      sites: {
        "post /doc": {
          xml: { request: description, response: { "200": description } },
          request: [{ k: "enum", path: "/S", map: { a: "b" }, c: "chg_s" }],
          response: {
            "200": [{ k: "enum", path: "/S", map: { b: "a" }, c: "chg_s" }],
          },
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

function runtime(): InvariantRuntime {
  return createRuntime({
    program: PROGRAM,
    identity: [{ kind: "default", label: "old" }],
    maxBodyBytes: 4 * 1024 * 1024,
  });
}

/** Sends a body to the runtime, and says how it ended and how long it took. */
function send(body: string): { refused?: Error; output?: string; ms: number } {
  const target = runtime();
  const site = target.siteFor("old", "post", "/doc");
  if (!site) throw new Error("no site");
  const started = performance.now();
  try {
    const output = target.transformRequestXml(site, body, {
      contract: "old",
      operation: "doc",
    });
    return { output, ms: performance.now() - started };
  } catch (error) {
    return { refused: error as Error, ms: performance.now() - started };
  }
}

describe("XML that would make the runtime expand, fetch or read", () => {
  it("refuses the billion laughs before a single entity is expanded", () => {
    const laughs = [
      '<?xml version="1.0"?>',
      "<!DOCTYPE lolz [",
      ' <!ENTITY lol "lol">',
      ...Array.from(
        { length: 9 },
        (_, level) =>
          ` <!ENTITY lol${level + 1} "${`&lol${level === 0 ? "" : level};`.repeat(10)}">`,
      ),
      "]>",
      "<R><S>&lol9;</S></R>",
    ].join("\n");
    const result = send(laughs);
    expect(result.refused).toBeInstanceOf(XmlBodyError);
    expect(result.refused?.message).toContain("document type declaration");
    expect(result.ms).toBeLessThan(50);
  });

  it("refuses an external entity, a file or a URL, without reading it", () => {
    for (const reference of [
      'SYSTEM "file:///etc/passwd"',
      'SYSTEM "http://169.254.169.254/latest/meta-data/"',
      'PUBLIC "-//x//y" "http://attacker.invalid/x.dtd"',
    ]) {
      const result = send(`<!DOCTYPE R [<!ENTITY x ${reference}>]><R><S>&x;</S></R>`);
      expect(result.refused, reference).toBeInstanceOf(XmlBodyError);
    }
    // A parameter entity, and an entity declared nowhere: neither is read.
    expect(
      send('<!DOCTYPE R [<!ENTITY % p SYSTEM "file:///etc/hosts"> %p;]><R/>').refused,
    ).toBeInstanceOf(XmlBodyError);
    expect(send("<R><S>&passwd;</S></R>").refused).toBeInstanceOf(XmlBodyError);
  });

  it("refuses a hundred thousand open tags as too deep, without exhausting the stack", () => {
    const result = send(`<R>${"<a>".repeat(100_000)}</R>`);
    expect(result.refused).toBeInstanceOf(BodyTooDeepError);
    expect(result.ms).toBeLessThan(200);
  });

  it("reads a document of a hundred thousand attributes in linear time", () => {
    const attributes = Array.from(
      { length: 100_000 },
      (_, index) => ` a${index}="x"`,
    ).join("");
    const result = send(`<R${attributes}><S>a</S></R>`);
    expect(result.output).toBe(`<R${attributes}><S>b</S></R>`);
    expect(result.ms).toBeLessThan(1000);
  });

  it("refuses namespace declarations past any real document's, before they multiply", () => {
    const declarations = Array.from(
      { length: 5_000 },
      (_, index) => ` xmlns:p${index}="urn:${index}"`,
    ).join("");
    const nested = Array.from(
      { length: 250 },
      (_, index) => `<n xmlns:q${index}="urn:q">`,
    );
    const result = send(
      `<R${declarations}>${nested.join("")}${"</n>".repeat(250)}<S>a</S></R>`,
    );
    expect(result.refused).toBeInstanceOf(XmlBodyError);
    expect(result.refused?.message).toContain("namespace declarations");
    expect(result.ms).toBeLessThan(200);
  });

  it("answers a document of a hundred thousand elements nothing names in linear time", () => {
    const body = `<R>${"<x><y>1</y></x>".repeat(100_000)}<S>a</S></R>`;
    const result = send(body);
    expect(result.output).toBe(body.replace("<S>a</S>", "<S>b</S>"));
    expect(result.ms).toBeLessThan(1000);
  });
});

describe("XML attacks through the proxy", () => {
  let upstream: Upstream;
  let proxy: Sidecar;

  beforeAll(async () => {
    upstream = await recordingUpstream(() => ({
      headers: { "content-type": "text/xml" },
      body: "<R><S>b</S></R>",
    }));
    proxy = await startSidecar(PROGRAM, { upstream: upstream.url });
  }, 60_000);
  afterAll(async () => {
    await proxy?.stop();
    await upstream?.close();
  });

  it("refuses an entity bomb with a 400 before the provider sees it", async () => {
    const response = await fetch(`${proxy.url}/doc`, {
      method: "POST",
      headers: { "content-type": "application/xml", "xml-version": "old" },
      body: '<!DOCTYPE R [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><R><S>&b;</S></R>',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("invariant_request_not_translatable");
    expect(upstream.seen).toEqual([]);
  });

  it("adapts an old caller's XML both ways", async () => {
    const response = await fetch(`${proxy.url}/doc`, {
      method: "POST",
      headers: { "content-type": "application/xml", "xml-version": "old" },
      body: "<R><S>a</S></R>",
    });
    expect(upstream.seen.at(-1)?.body).toBe("<R><S>b</S></R>");
    expect(await response.text()).toBe("<R><S>a</S></R>");
  });
});
