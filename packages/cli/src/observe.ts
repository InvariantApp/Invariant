/**
 * `invariant observe`: what the API actually answers, against what its
 * specification says it answers.
 *
 * The first rung of the ladder asks a provider to put a specification under
 * the gate. That is a fair thing to ask, and a large number of specifications
 * are generated from code by a tool that was never checked against traffic:
 * fields that are always there are marked optional, fields that are sometimes
 * null are not marked nullable, an enum lists three of the five values the
 * service returns. Everything built on top of such a document inherits its
 * errors, and the provider has no way to know before they adopt anything.
 *
 * So this stands in front of the API and adapts nothing. It forwards every
 * request as it is, and checks a sample of the answers against the current
 * contract, counting what does not hold: which operation, which status, which
 * field, and what was wrong with it. No value is ever recorded, which is what
 * makes it safe to point at real traffic: the report says
 * `/items/*\/price: expected string, found number`, and nobody's price.
 *
 * Nothing here is in the request's way. The answer is streamed to the caller
 * as it arrives; the sample is read from a copy, checked after the caller has
 * been served, and a check that throws is counted and forgotten.
 */

import { writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  loadContract,
  type OpenApiDocument,
  operationsOf,
  responseSchemas,
} from "@invariant-app/contract";
import { validateSchema } from "@invariant-app/verifier";
import type { InvariantConfig } from "./config.ts";

export interface ObserveOptions {
  /** Where the API this stands in front of is listening. */
  upstream: string;
  /** The port to listen on; 0 picks one, which the caller is told. */
  port: number;
  /** How many answers in a hundred to check. */
  samplePercent: number;
  /** The most bytes of one answer to read for checking. */
  maxBodyBytes: number;
  /** Where to write the report, if anywhere. */
  out?: string | undefined;
}

export interface ObservedPlace {
  operation: string;
  status: string;
  /** The field, as a JSON Pointer into the body; `*` is a list's items. */
  pointer: string;
  /** What did not hold, with no value in it. */
  problem: string;
  responses: number;
}

export interface ObserveReport {
  /** The contract every answer was checked against. */
  contract: string;
  /** Answers seen, and of those, answers checked. */
  answers: number;
  checked: number;
  /** Answers whose operation is not in the contract at all. */
  unknownOperations: number;
  /** Answers with no schema for their status, which nothing can check. */
  undescribed: number;
  /** Answers that held, and answers that did not. */
  held: number;
  broke: number;
  places: ObservedPlace[];
}

/** One operation of the contract, matched by method and path template. */
interface Endpoint {
  method: string;
  operationId: string;
  segments: string[];
  responses: Map<string, unknown>;
}

function endpointsOf(document: OpenApiDocument): Endpoint[] {
  return operationsOf(document).map((operation) => ({
    method: operation.method.toUpperCase(),
    operationId: operation.operationId,
    segments: operation.path.split("/").filter((segment) => segment !== ""),
    responses: new Map(
      responseSchemas(document, operation.operation).map((entry) => [
        entry.status,
        entry.schema,
      ]),
    ),
  }));
}

/** The operation a request reached, by the same rule a router uses. */
export function endpointFor(
  endpoints: readonly Endpoint[],
  method: string,
  path: string,
): Endpoint | undefined {
  const asked =
    path
      .split("?")[0]
      ?.split("/")
      .filter((segment) => segment !== "") ?? [];
  return endpoints.find(
    (endpoint) =>
      endpoint.method === method.toUpperCase() &&
      endpoint.segments.length === asked.length &&
      endpoint.segments.every(
        (segment, index) => segment.startsWith("{") || segment === asked[index],
      ),
  );
}

/** The status's schema, or the range's, or the default's, as a contract writes them. */
function schemaFor(endpoint: Endpoint, status: number): unknown {
  const exact = endpoint.responses.get(String(status));
  if (exact !== undefined) return exact;
  const range = endpoint.responses.get(`${Math.floor(status / 100)}XX`);
  if (range !== undefined) return range;
  return endpoint.responses.get("default");
}

/**
 * A place, written so that the same field in every element of a list is one
 * place rather than one per element: what a provider fixes is the field.
 */
function placeOf(pointer: string): string {
  return pointer.replace(/\/\d+(?=\/|$)/g, "/*");
}

export interface Observer {
  /** Where it is listening, once started. */
  url: string;
  report(): ObserveReport;
  close(): Promise<ObserveReport>;
}

export async function observe(
  config: InvariantConfig,
  options: ObserveOptions,
): Promise<Observer> {
  const contract = await loadContract(
    config.currentSpec,
    config.currentLabel ?? "current",
  );
  const endpoints = endpointsOf(contract.document);
  const upstream = new URL(options.upstream);
  const counts = new Map<string, ObservedPlace>();
  const report: ObserveReport = {
    contract: contract.label,
    answers: 0,
    checked: 0,
    unknownOperations: 0,
    undescribed: 0,
    held: 0,
    broke: 0,
    places: [],
  };

  const check = (method: string, path: string, status: number, body: string): void => {
    const endpoint = endpointFor(endpoints, method, path);
    if (!endpoint) {
      report.unknownOperations += 1;
      return;
    }
    const schema = schemaFor(endpoint, status);
    if (schema === undefined) {
      report.undescribed += 1;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      report.undescribed += 1;
      return;
    }
    const violations = validateSchema(contract.document, schema as never, value as never);
    report.checked += 1;
    if (violations.length === 0) {
      report.held += 1;
      return;
    }
    report.broke += 1;
    const seen = new Set<string>();
    for (const violation of violations) {
      const pointer = placeOf(violation.pointer);
      const key = `${endpoint.operationId}\u0000${status}\u0000${pointer}\u0000${violation.safe}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const place = counts.get(key);
      if (place) place.responses += 1;
      else
        counts.set(key, {
          operation: endpoint.operationId,
          status: String(status),
          pointer,
          problem: violation.safe,
          responses: 1,
        });
    }
  };

  const server = createServer((incoming, answer) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const forwarded = httpRequest(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port,
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers, host: upstream.host },
        },
        (response: IncomingMessage) => {
          report.answers += 1;
          answer.writeHead(response.statusCode ?? 502, response.headers);
          const sampled =
            Math.random() * 100 < options.samplePercent &&
            /[/+]json(;|$)/.test(String(response.headers["content-type"] ?? ""));
          const copy: Buffer[] = [];
          let size = 0;
          let overflowed = false;
          response.on("data", (chunk: Buffer) => {
            answer.write(chunk);
            if (!sampled || overflowed) return;
            size += chunk.byteLength;
            if (size > options.maxBodyBytes) {
              overflowed = true;
              copy.length = 0;
              return;
            }
            copy.push(chunk);
          });
          response.on("end", () => {
            answer.end();
            if (!sampled || overflowed) return;
            // After the caller has their answer, and never in their way: a
            // check that throws is counted and forgotten.
            try {
              check(
                incoming.method ?? "GET",
                incoming.url ?? "/",
                response.statusCode ?? 0,
                Buffer.concat(copy).toString("utf8"),
              );
            } catch {
              report.undescribed += 1;
            }
          });
        },
      );
      forwarded.on("error", () => {
        if (!answer.headersSent) answer.writeHead(502);
        answer.end();
      });
      forwarded.end(Buffer.concat(chunks));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const address = server.address() as AddressInfo;
  const finish = (): ObserveReport => ({
    ...report,
    places: [...counts.values()].sort((a, b) => b.responses - a.responses),
  });

  return {
    url: `http://127.0.0.1:${address.port}`,
    report: finish,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const final = finish();
      if (options.out !== undefined) {
        await writeFile(options.out, `${JSON.stringify(final, null, 2)}\n`);
      }
      return final;
    },
  };
}

/** The report as a person reads it: what held, what did not, and where. */
export function renderObservation(report: ObserveReport): string {
  const lines = [
    `Against ${report.contract}: ${report.answers} answers, ${report.checked} checked, ` +
      `${report.held} held, ${report.broke} did not.`,
  ];
  if (report.unknownOperations > 0) {
    lines.push(
      `${report.unknownOperations} answers were for paths the contract does not describe.`,
    );
  }
  if (report.undescribed > 0) {
    lines.push(`${report.undescribed} answers had nothing to check them against.`);
  }
  if (report.places.length === 0) {
    lines.push(
      report.checked === 0
        ? "Nothing was checked. Send some traffic through it."
        : "Every answer checked matched the contract.",
    );
    return lines.join("\n");
  }
  lines.push("", "What did not hold, most often first:");
  for (const place of report.places.slice(0, 40)) {
    lines.push(
      `  ${place.responses.toString().padStart(6)}  ${place.operation} ${place.status} ` +
        `${place.pointer || "the body"}: ${place.problem}`,
    );
  }
  if (report.places.length > 40) {
    lines.push(`  and ${report.places.length - 40} more.`);
  }
  return lines.join("\n");
}
