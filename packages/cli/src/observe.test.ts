/**
 * Rung zero, against a service that does not answer what it says it does.
 *
 * The point of observing is that a provider can point it at real traffic
 * before they have adopted anything, so two things have to hold: what it
 * reports has to be true, and nothing it reports may carry a value out of
 * someone's response.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { observe, renderObservation } from "./observe.ts";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "acme", version: "1" },
  paths: {
    "/v1/things/{id}": {
      get: {
        operationId: "getThing",
        responses: {
          "200": {
            description: "one",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "state"],
                  properties: {
                    id: { type: "string" },
                    state: { type: "string", enum: ["open", "closed"] },
                    price: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

let root: string;
let upstream: Server;
let answer: unknown;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "invariant-observe-"));
  await writeFile(join(root, "openapi.json"), JSON.stringify(SPEC));
  await writeFile(
    join(root, "invariant.yaml"),
    [
      "api: acme",
      "spec:",
      "  current: openapi.json",
      '  currentLabel: "2026-01-15"',
    ].join("\n"),
  );
  upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => upstream.listen(0, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const observing = async (out?: string) => {
  const config = await loadConfig(join(root, "invariant.yaml"));
  const port = (upstream.address() as AddressInfo).port;
  return observe(config, {
    upstream: `http://127.0.0.1:${port}`,
    port: 0,
    samplePercent: 100,
    maxBodyBytes: 1_000_000,
    ...(out === undefined ? {} : { out }),
  });
};

describe("observing an API", () => {
  it("answers the caller as the API did, and says what did not hold", async () => {
    answer = { id: "1", state: "archived", price: 12 };
    const observer = await observing();
    const response = await fetch(`${observer.url}/v1/things/1`);
    expect(response.status).toBe(200);
    // The caller gets exactly what the API said, untouched.
    expect(await response.json()).toEqual({ id: "1", state: "archived", price: 12 });
    const report = await observer.close();
    expect(report).toMatchObject({ answers: 1, checked: 1, held: 0, broke: 1 });
    const places = report.places.map((place) => `${place.pointer}: ${place.problem}`);
    expect(places).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/state"),
        expect.stringContaining("/price"),
      ]),
    );
    // Nothing anyone was sent is in the report.
    expect(JSON.stringify(report)).not.toContain("archived");
    expect(JSON.stringify(report)).not.toContain("12");
  });

  it("says so when every answer holds", async () => {
    answer = { id: "1", state: "open", price: "12.00" };
    const observer = await observing();
    await fetch(`${observer.url}/v1/things/1`);
    const report = await observer.close();
    expect(report).toMatchObject({ checked: 1, held: 1, broke: 0 });
    expect(renderObservation(report)).toContain("Every answer checked matched");
  });

  it("counts an answer for a path the contract does not describe", async () => {
    answer = { anything: true };
    const observer = await observing();
    await fetch(`${observer.url}/v1/unknown`);
    const report = await observer.close();
    expect(report).toMatchObject({ answers: 1, checked: 0, unknownOperations: 1 });
  });

  it("counts the same field in every element of a list once", async () => {
    answer = { id: "1", state: "open" };
    const observer = await observing();
    await fetch(`${observer.url}/v1/things/1`);
    await fetch(`${observer.url}/v1/things/2`);
    const report = await observer.close();
    expect(report.places).toEqual([]);
  });

  it("writes the report where it is asked to", async () => {
    answer = { id: "1" };
    const out = join(root, "observed.json");
    const observer = await observing(out);
    await fetch(`${observer.url}/v1/things/1`);
    const report = await observer.close();
    expect(report.broke).toBe(1);
    const written = JSON.parse(
      await (await import("node:fs/promises")).readFile(out, "utf8"),
    );
    expect(written.places[0].pointer).toBe("/state");
  });
});
