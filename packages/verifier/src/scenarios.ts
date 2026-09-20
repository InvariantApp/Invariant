/**
 * Scenarios: what to ask both builds.
 *
 * A single request proves very little about an API. What breaks in practice is
 * a sequence - create something, read it back, list it - because that is where
 * an identifier minted by one call has to be understood by the next. So a
 * scenario is an ordered list of requests with captures, and a later step can
 * refer to what an earlier one returned.
 *
 * Scenarios are written against a historical contract, in that contract's own
 * shapes, because that is the traffic whose meaning has to be preserved.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isJsonObject, type JsonValue } from "@invariant/ir";
import { parse as parseYaml } from "yaml";

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

export interface ScenarioStep {
  /** Name later steps use to refer to what this one captured. */
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: JsonValue | undefined;
  /** Capture name to JSON Pointer within the response body. */
  capture: Record<string, string>;
  /** Status this step is expected to return, when it is deliberately an error. */
  expectStatus: number | undefined;
}

/**
 * A difference the provider has looked at and accepted.
 *
 * This exists because one real limitation has no mechanical fix. An error's
 * `param` can be mapped back to the name the old contract used, because that is
 * a value in a known place. The prose beside it cannot: rewriting a sentence is
 * not a shape transform, and the IR deliberately has no expressions to do it
 * with. So an old caller can receive a message naming a field it has never
 * heard of.
 *
 * Rather than quietly excluding message text from the comparison, which would
 * also hide the next thing that goes wrong there, the provider names the exact
 * path and writes down why. The acknowledgement travels in the evidence record,
 * so a reviewer sees the sentence rather than a silence.
 */
export interface Acknowledgement {
  /** Step id, then the JSON Pointer within that step's body. */
  step: string;
  pointer: string;
  reason: string;
}

export interface Scenario {
  name: string;
  /** The contract the requests are written in. */
  contract: string;
  steps: ScenarioStep[];
  acknowledged: Acknowledgement[];
}

function str(value: JsonValue | undefined, where: string): string {
  if (typeof value !== "string") throw new ScenarioError(`${where} must be a string`);
  return value;
}

function stepFrom(raw: JsonValue, index: number, where: string): ScenarioStep {
  if (!isJsonObject(raw))
    throw new ScenarioError(`${where} step ${index} is not a mapping`);

  const request = raw["request"];
  if (!isJsonObject(request)) {
    throw new ScenarioError(`${where} step ${index} needs a request`);
  }

  const headers: Record<string, string> = {};
  const rawHeaders = request["headers"];
  if (isJsonObject(rawHeaders)) {
    for (const [name, value] of Object.entries(rawHeaders)) {
      headers[name.toLowerCase()] = str(value, `${where} step ${index} header ${name}`);
    }
  }

  const capture: Record<string, string> = {};
  const rawCapture = raw["capture"];
  if (isJsonObject(rawCapture)) {
    for (const [name, pointer] of Object.entries(rawCapture)) {
      capture[name] = str(pointer, `${where} capture ${name}`);
    }
  }

  const status = raw["expectStatus"];

  return {
    id: typeof raw["id"] === "string" ? raw["id"] : `step${index}`,
    method: str(request["method"], `${where} step ${index} method`).toUpperCase(),
    path: str(request["path"], `${where} step ${index} path`),
    headers,
    body: request["body"],
    capture,
    expectStatus: typeof status === "number" ? status : undefined,
  };
}

export function parseScenario(text: string, where: string): Scenario {
  const raw: unknown = parseYaml(text);
  if (!isJsonObject(raw)) throw new ScenarioError(`${where} is not a mapping`);

  const steps = raw["steps"];
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ScenarioError(`${where} needs at least one step`);
  }

  const acknowledged: Acknowledgement[] = [];
  const rawAcknowledged = raw["acknowledged"];
  if (Array.isArray(rawAcknowledged)) {
    rawAcknowledged.forEach((entry, index) => {
      if (!isJsonObject(entry)) {
        throw new ScenarioError(`${where} acknowledged ${index} is not a mapping`);
      }
      const reason = str(entry["reason"], `${where} acknowledged ${index} reason`);
      // A blank reason would make the whole mechanism a silent ignore list.
      if (reason.trim().length < 10) {
        throw new ScenarioError(
          `${where} acknowledged ${index} needs a reason saying why this ` +
            "difference is acceptable for a caller on the old contract",
        );
      }
      acknowledged.push({
        step: str(entry["step"], `${where} acknowledged ${index} step`),
        pointer: str(entry["pointer"], `${where} acknowledged ${index} pointer`),
        reason,
      });
    });
  }

  return {
    name: str(raw["name"], `${where} name`),
    contract: str(raw["contract"], `${where} contract`),
    steps: steps.map((step, index) => stepFrom(step as JsonValue, index, where)),
    acknowledged,
  };
}

export async function loadScenarios(directory: string): Promise<Scenario[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".yaml")).sort();
  } catch {
    return [];
  }

  return Promise.all(
    names.map(async (name) =>
      parseScenario(await readFile(join(directory, name), "utf8"), name),
    ),
  );
}

/**
 * Fills `${step.name}` references from what earlier steps captured.
 *
 * A missing reference is an error rather than an empty string. Substituting
 * nothing would turn a broken scenario into a request for `/v1/payments/`,
 * which fails somewhere else entirely and sends whoever reads the report after
 * the wrong thing.
 */
export function substitute(
  value: JsonValue,
  captured: Map<string, JsonValue>,
): JsonValue {
  if (typeof value === "string") {
    const whole = /^\$\{([A-Za-z0-9_.]+)\}$/.exec(value);
    if (whole) return lookup(whole[1] as string, captured);

    return value.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (_match, name: string) => {
      const found = lookup(name, captured);
      return typeof found === "string" ? found : JSON.stringify(found);
    });
  }

  if (Array.isArray(value)) return value.map((entry) => substitute(entry, captured));

  if (isJsonObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = substitute(entry, captured);
    }
    return out;
  }

  return value;
}

function lookup(name: string, captured: Map<string, JsonValue>): JsonValue {
  const found = captured.get(name);
  if (found === undefined) {
    throw new ScenarioError(
      `\${${name}} was never captured. Known: ${[...captured.keys()].join(", ") || "nothing"}`,
    );
  }
  return found;
}
