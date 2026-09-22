/**
 * Conformance: does the code actually do what its specification says?
 *
 * Everything else in this system reasons about the specification. The diff is
 * taken between two of them, closure is proved against one, the lens laws
 * generate values from one. All of that is worth nothing if the document does
 * not describe the running code, and a specification drifting from its
 * implementation is the most ordinary failure in the whole area.
 *
 * So the current build is asked real questions and every answer is checked
 * against what the contract promised. It is the cheapest check here and the one
 * that holds the others up.
 */
import {
  type OpenApiDocument,
  operationsOf,
  responseSchemas,
} from "@invariant-app/contract";
import type { JsonValue } from "@invariant-app/ir";
import { matchTemplate } from "@invariant-app/runtime";
import type { Target } from "./differential.ts";
import { type Evidence, inputsDigest } from "./evidence.ts";
import { type Scenario, substitute } from "./scenarios.ts";
import { type Violation, validateSchema } from "./validate.ts";

export interface ConformanceFailure {
  scenario: string;
  step: string;
  operation: string;
  status: number;
  violations: Violation[];
}

export interface ConformanceReport {
  evidence: Evidence[];
  failures: ConformanceFailure[];
  /** Steps whose operation is not in the contract at all. */
  unknownOperations: string[];
}

/**
 * Matches a concrete path against a path template, ignoring parameter values,
 * by the rule the runtime routes with, so a custom method such as
 * `{name}:cancel` is the same operation to both.
 */
function matches(template: string, path: string): boolean {
  return matchTemplate(template.split("/"), path.split("?")[0] ?? "") !== undefined;
}

function schemaFor(
  document: OpenApiDocument,
  method: string,
  path: string,
  status: number,
): { operationId: string; schema: JsonValue | undefined } | undefined {
  for (const operation of operationsOf(document)) {
    if (operation.method !== method.toLowerCase()) continue;
    if (!matches(operation.path, path)) continue;

    const declared = responseSchemas(document, operation.operation);
    const exact = declared.find((entry) => entry.status === String(status));
    const byClass = declared.find(
      (entry) =>
        entry.status === `${Math.floor(status / 100)}XX`.toLowerCase() ||
        entry.status === `${Math.floor(status / 100)}xx`,
    );
    const fallback = declared.find((entry) => entry.status === "default");

    return {
      operationId: operation.operationId,
      schema: (exact ?? byClass ?? fallback)?.schema,
    };
  }
  return undefined;
}

/**
 * Runs scenarios against one build and validates every response.
 *
 * The scenarios have to be written in the contract being checked, because the
 * point is to compare the build's own output with its own promises. Running
 * old-contract traffic here would only prove things about the adapter.
 */
export async function checkConformance(
  document: OpenApiDocument,
  label: string,
  scenarios: readonly Scenario[],
  open: () => Promise<Target>,
): Promise<ConformanceReport> {
  const failures: ConformanceFailure[] = [];
  const unknownOperations: string[] = [];
  const evidence: Evidence[] = [];

  for (const scenario of scenarios) {
    const found: ConformanceFailure[] = [];
    const target = await open();
    let checked = 0;

    try {
      const captured = new Map<string, JsonValue>();

      for (const step of scenario.steps) {
        const path = substitute(step.path, captured) as string;
        const body =
          step.body === undefined ? undefined : substitute(step.body, captured);

        const headers = new Headers(step.headers);
        if (body !== undefined) headers.set("content-type", "application/json");

        const response = await target.fetch(
          new Request(`http://conform${path}`, {
            method: step.method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );

        const text = await response.text();
        let parsed: JsonValue = null;
        try {
          parsed = text === "" ? null : (JSON.parse(text) as JsonValue);
        } catch {
          parsed = text;
        }

        for (const [name, pointer] of Object.entries(step.capture)) {
          captured.set(`${step.id}.${name}`, valueAt(parsed, pointer));
        }

        const target_ = schemaFor(document, step.method, path, response.status);
        if (!target_) {
          unknownOperations.push(`${scenario.name}/${step.id}: ${step.method} ${path}`);
          continue;
        }
        if (!target_.schema) {
          // The contract declares the operation but not this status. That is a
          // gap in the specification, and saying so is more useful than
          // silently treating it as conformant.
          found.push({
            scenario: scenario.name,
            step: step.id,
            operation: target_.operationId,
            status: response.status,
            violations: [
              {
                pointer: "/",
                message: `the contract does not describe a ${response.status} response for this operation`,
              },
            ],
          });
          continue;
        }

        checked += 1;
        const violations = validateSchema(document, target_.schema, parsed);
        if (violations.length > 0) {
          found.push({
            scenario: scenario.name,
            step: step.id,
            operation: target_.operationId,
            status: response.status,
            violations,
          });
        }
      }
    } finally {
      await target.close();
    }

    failures.push(...found);
    evidence.push({
      kind: "E7-conformance",
      subject: `${label}: ${scenario.name}`,
      result: found.length > 0 ? "fail" : "pass",
      inputsDigest: inputsDigest(scenario, label),
      tool: "invariant conformance",
      summary:
        found.length > 0
          ? `${found.length} responses do not match what the contract describes`
          : `${checked} responses match what contract ${label} describes`,
      ...(found.length > 0
        ? {
            detail: found.map(
              (entry) =>
                `${entry.step} (${entry.operation} ${entry.status}): ` +
                entry.violations
                  .slice(0, 5)
                  .map((violation) => `${violation.pointer} ${violation.message}`)
                  .join("; "),
            ),
          }
        : {}),
    });
  }

  return { evidence, failures, unknownOperations };
}

function valueAt(body: JsonValue, pointer: string): JsonValue {
  let cursor: JsonValue = body;
  for (const segment of pointer.split("/").slice(1)) {
    if (Array.isArray(cursor)) cursor = (cursor[Number(segment)] ?? null) as JsonValue;
    else if (cursor !== null && typeof cursor === "object") {
      cursor = ((cursor as Record<string, JsonValue>)[segment] ?? null) as JsonValue;
    } else return null;
  }
  return cursor;
}
