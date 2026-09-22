/**
 * The differential check: does the new build, with the adapter, still behave
 * like the old build did?
 *
 * This is the only layer that runs the provider's real code, and so the only
 * one that can catch a fault that is invisible in a specification. Two matter
 * especially. A value map whose pairs are swapped round trips perfectly and
 * preserves the set of allowed values, so neither closure nor the lens laws can
 * see it - but the old build says `succeeded` where the new one says
 * `processing`, and that shows up here on the first request. And a handler
 * whose behaviour changed underneath an unchanged shape is not a shape problem
 * at all; only running both can find it.
 *
 * Production traffic is never replayed. Both builds are stood up fresh, with
 * fresh state, and asked the same scripted questions.
 *
 * `≈` is defined here, and defining it is most of the work. Two responses are
 * equivalent when they have the same status, the same structure, and the same
 * values at every path that is not volatile. Volatility is measured rather than
 * configured: the old build is run twice before the comparison, and any path
 * that disagrees with itself is one the API was never promising to keep stable.
 * Identifiers and timestamps fall out of that automatically, and so does
 * anything else the provider happens to generate, without a list to maintain.
 */
import { isJsonObject, type JsonValue } from "@invariant-app/ir";
import { type Evidence, inputsDigest } from "./evidence.ts";
import { type Scenario, substitute, type Unordered } from "./scenarios.ts";

/** A running build, however it was started. */
export interface Target {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Starts one build with empty state.
 *
 * `build` is a contract label for a historical build, or `head` for the current
 * one. State must be fresh every call: two runs of the same build sharing a
 * store would make every identifier look stable and hide real volatility.
 */
export type Launcher = (build: string) => Promise<Target>;

export interface StepObservation {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: JsonValue;
}

export interface Difference {
  scenario: string;
  step: string;
  pointer: string;
  detail: string;
  /** Present when the provider wrote down why this one is acceptable. */
  acknowledged?: string;
}

export interface DifferentialOptions {
  launch: Launcher;
  /**
   * Label of the contract the current build speaks.
   *
   * Scenarios written in it are skipped rather than run. There is no older
   * build to compare against, so "the old build and the new build agree" would
   * be comparing the current build with itself and reporting a pass that means
   * nothing. Those scenarios belong to the conformance check, which asks a
   * different question of the same requests.
   */
  currentLabel?: string;
  /**
   * Every historical contract that still has a build.
   *
   * A scenario naming anything else is a mistake, and an expensive one to leave
   * undetected: launching the wrong build compares something with itself and
   * reports a confident pass having proved nothing. Given the list, a typo
   * fails loudly instead.
   */
  knownContracts?: readonly string[];
  /** Header the head build reads to learn which contract a caller speaks. */
  contractHeader?: string;
  /** Response headers worth comparing. Everything else is ignored. */
  compareHeaders?: readonly string[];
  /**
   * Called as each build is started and each scenario finishes.
   *
   * This layer is the only one that costs seconds rather than milliseconds, and
   * the only one that can stall waiting on something outside the process. A
   * silent ten minutes is indistinguishable from a hang, so it says where it is.
   */
  onProgress?: (message: string) => void;
}

export interface DifferentialReport {
  evidence: Evidence[];
  /** Differences nobody has accounted for. These block the release. */
  differences: Difference[];
  /** Differences the provider named and justified in the scenario. */
  acknowledged: Difference[];
  /** Paths the old build did not keep stable against itself, per scenario. */
  volatile: Map<string, string[]>;
}

const DEFAULT_COMPARED_HEADERS = ["content-type"];

/**
 * The name a scenario uses for "whatever the current contract is".
 *
 * A contract label is minted at release time from the date, so a scenario
 * written weeks earlier cannot name it. `head` is how the provider says it
 * means the build they are about to ship.
 */
export const CURRENT_CONTRACT_ALIAS = "head";

export function isCurrent(contract: string, currentLabel: string | undefined): boolean {
  return contract === CURRENT_CONTRACT_ALIAS || contract === currentLabel;
}

/** Flattens a body into pointer-to-scalar, which is what comparison works on. */
function flatten(
  value: JsonValue,
  prefix = "",
  out = new Map<string, JsonValue>(),
): Map<string, JsonValue> {
  if (Array.isArray(value)) {
    out.set(`${prefix}[]`, value.length);
    value.forEach((entry, index) => {
      flatten(entry, `${prefix}/${index}`, out);
    });
    return out;
  }
  if (isJsonObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      flatten(entry, `${prefix}/${key}`, out);
    }
    return out;
  }
  out.set(prefix || "/", value);
  return out;
}

async function observe(
  target: Target,
  scenario: Scenario,
  extraHeaders: Record<string, string>,
  compared: readonly string[],
): Promise<StepObservation[]> {
  const captured = new Map<string, JsonValue>();
  const out: StepObservation[] = [];

  for (const step of scenario.steps) {
    const path = substitute(step.path, captured) as string;
    const body = step.body === undefined ? undefined : substitute(step.body, captured);

    const headers = new Headers({ ...step.headers, ...extraHeaders });
    if (body !== undefined) headers.set("content-type", "application/json");

    const response = await target.fetch(
      new Request(`http://verify${path}`, {
        method: step.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

    const text = await response.text();
    let parsed: JsonValue;
    try {
      parsed = text === "" ? null : (JSON.parse(text) as JsonValue);
    } catch {
      parsed = text;
    }

    const seen: Record<string, string> = {};
    for (const name of compared) {
      const value = response.headers.get(name);
      if (value !== null) seen[name] = value;
    }

    out.push({ id: step.id, status: response.status, headers: seen, body: parsed });

    for (const [name, pointer] of Object.entries(step.capture)) {
      captured.set(`${step.id}.${name}`, valueAt(parsed, pointer));
    }
  }

  return out;
}

function valueAt(body: JsonValue, pointer: string): JsonValue {
  let cursor: JsonValue = body;
  for (const segment of pointer.split("/").slice(1)) {
    if (Array.isArray(cursor)) cursor = (cursor[Number(segment)] ?? null) as JsonValue;
    else if (isJsonObject(cursor)) cursor = (cursor[segment] ?? null) as JsonValue;
    else return null;
  }
  return cursor;
}

/**
 * Waits until the wall clock crosses into the next whole second.
 *
 * The two calibration runs have to be capable of disagreeing, or the
 * calibration proves nothing. Fresh state is enough to expose a generated
 * identifier, but a timestamp at second resolution is identical in two runs a
 * few milliseconds apart, so it would look stable, and then differ between the
 * old build and the new one whenever the comparison happened to straddle a
 * tick. That is a test that fails once a minute for no reason, which is worse
 * than one that never runs.
 *
 * Crossing a tick between the two runs makes anything derived from the clock
 * reveal itself, without a list of field names to keep up to date.
 */
async function nextTick(): Promise<void> {
  const now = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 1000 - (now % 1000) + 5));
}

/**
 * Paths the old build did not reproduce when asked the same thing twice.
 *
 * Running base against itself is what makes the comparison trustworthy. Without
 * it every identifier and timestamp would report as a difference, and the only
 * way to get a green run would be to maintain a list of fields to ignore, which
 * drifts and eventually hides something real.
 */
export class CalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationError";
  }
}

export function volatilePaths(
  a: readonly StepObservation[],
  b: readonly StepObservation[],
): Set<string> {
  // Two runs of the same build that answered a different number of steps have
  // not calibrated anything. Skipping the missing ones used to look harmless and
  // is the opposite: a step with no calibration has no volatile paths, so every
  // value it derives from the clock is then reported as a difference between the
  // old build and the new one. That is how this check failed once under load,
  // on a fixture whose timestamps come from the second the server started.
  if (a.length !== b.length) {
    throw new CalibrationError(
      `The old build answered ${a.length} steps and then ${b.length} for the ` +
        "same scenario, so nothing can be said about which of its values are " +
        "stable. Calibration has to be repeatable before a comparison against " +
        "it means anything.",
    );
  }

  const volatile = new Set<string>();

  a.forEach((left, index) => {
    const right = b[index];
    if (!right) {
      throw new CalibrationError(`The old build skipped ${left.id} on the second run.`);
    }
    const leftPaths = flatten(left.body);
    const rightPaths = flatten(right.body);

    for (const [pointer, value] of leftPaths) {
      const other = rightPaths.get(pointer);
      if (other === undefined || JSON.stringify(other) !== JSON.stringify(value)) {
        volatile.add(`${left.id}${pointer}`);
      }
    }
    for (const pointer of rightPaths.keys()) {
      if (!leftPaths.has(pointer)) volatile.add(`${left.id}${pointer}`);
    }
  });

  return volatile;
}

/** JSON with object keys sorted, so equal values are equal text. */
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function unescapeSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** The value at a pointer inside one item, for sorting by. */
function within(value: JsonValue, pointer: string | undefined): JsonValue {
  if (pointer === undefined || pointer === "") return value;
  let cursor: JsonValue = value;
  for (const segment of pointer.split("/").slice(1).map(unescapeSegment)) {
    if (Array.isArray(cursor)) cursor = (cursor[Number(segment)] ?? null) as JsonValue;
    else if (isJsonObject(cursor)) cursor = (cursor[segment] ?? null) as JsonValue;
    else return null;
  }
  return cursor;
}

/**
 * Observations with every list a scenario declares unordered sorted the one
 * way, so two runs that returned the same things in another order agree.
 */
export function inDeclaredOrder(
  observations: readonly StepObservation[],
  unordered: readonly Unordered[],
): StepObservation[] {
  if (unordered.length === 0) return [...observations];
  return observations.map((observation) => {
    const mine = unordered.filter((entry) => entry.step === observation.id);
    if (mine.length === 0) return observation;
    let sorted = observation;
    for (const entry of mine) {
      const segments = entry.pointer.split("/").slice(1).map(unescapeSegment);
      const visit = (node: JsonValue, at: number): JsonValue => {
        if (at === segments.length) {
          if (!Array.isArray(node)) return node;
          const key = (item: JsonValue) => canonical(within(item, entry.by));
          return [...node].sort((a, b) =>
            key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
          );
        }
        const segment = segments[at] as string;
        if (segment === "*" && Array.isArray(node)) {
          return node.map((item) => visit(item, at + 1));
        }
        if (isJsonObject(node) && segment in node) {
          return { ...node, [segment]: visit(node[segment] as JsonValue, at + 1) };
        }
        if (Array.isArray(node) && node[Number(segment)] !== undefined) {
          const copy = [...node];
          copy[Number(segment)] = visit(copy[Number(segment)] as JsonValue, at + 1);
          return copy;
        }
        return node;
      };
      sorted = { ...sorted, body: visit(sorted.body, 0) };
    }
    return sorted;
  });
}

function kindOf(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function compare(
  scenario: string,
  base: readonly StepObservation[],
  head: readonly StepObservation[],
  volatile: ReadonlySet<string>,
): Difference[] {
  const out: Difference[] = [];

  base.forEach((left, index) => {
    const right = head[index];
    if (!right) {
      out.push({
        scenario,
        step: left.id,
        pointer: "/",
        detail: "the new build did not answer this step at all",
      });
      return;
    }

    if (left.status !== right.status) {
      out.push({
        scenario,
        step: left.id,
        pointer: "/",
        detail: `the old build answered ${left.status}, the new one answered ${right.status}`,
      });
    }

    for (const [name, value] of Object.entries(left.headers)) {
      if (right.headers[name] !== value) {
        out.push({
          scenario,
          step: left.id,
          pointer: `header ${name}`,
          detail: `was ${value}, now ${right.headers[name] ?? "absent"}`,
        });
      }
    }

    const leftPaths = flatten(left.body);
    const rightPaths = flatten(right.body);

    for (const [pointer, value] of leftPaths) {
      const key = `${left.id}${pointer}`;
      const other = rightPaths.get(pointer);

      if (other === undefined) {
        // A field the old contract carried has gone missing. That is breakage
        // whether or not the value was stable, so volatility does not excuse it.
        out.push({
          scenario,
          step: left.id,
          pointer,
          detail: "the old build returned this, the new one does not",
        });
        continue;
      }

      if (volatile.has(key)) {
        // Generated values are compared by shape only: an identifier is still
        // required to be a string, just not the same string.
        if (kindOf(other) !== kindOf(value)) {
          out.push({
            scenario,
            step: left.id,
            pointer,
            detail: `was a ${kindOf(value)}, now a ${kindOf(other)}`,
          });
        }
        continue;
      }

      if (JSON.stringify(other) !== JSON.stringify(value)) {
        out.push({
          scenario,
          step: left.id,
          pointer,
          detail: `was ${JSON.stringify(value)}, now ${JSON.stringify(other)}`,
        });
      }
    }

    for (const pointer of rightPaths.keys()) {
      if (!leftPaths.has(pointer)) {
        out.push({
          scenario,
          step: left.id,
          pointer,
          detail: "the new build returned this, which the old contract never had",
        });
      }
    }
  });

  return out;
}

/**
 * Runs every scenario against the old build and the new build plus adapter.
 *
 * Three runs per scenario, and the order matters: both base runs happen before
 * head is consulted, so volatility is established from the old build alone and
 * cannot be influenced by whatever the new one does.
 */
export async function checkDifferential(
  scenarios: readonly Scenario[],
  options: DifferentialOptions,
): Promise<DifferentialReport> {
  const compared = options.compareHeaders ?? DEFAULT_COMPARED_HEADERS;
  const differences: Difference[] = [];
  const acknowledgedOut: Difference[] = [];
  const evidence: Evidence[] = [];
  const volatileByScenario = new Map<string, string[]>();

  for (const scenario of scenarios) {
    if (isCurrent(scenario.contract, options.currentLabel)) {
      evidence.push({
        kind: "E6-differential",
        subject: `${scenario.contract}: ${scenario.name}`,
        result: "skipped",
        inputsDigest: inputsDigest(scenario),
        tool: "invariant differential",
        summary:
          "written in the current contract, so there is no earlier build to " +
          "compare against. The conformance check covers it instead.",
      });
      continue;
    }

    if (options.knownContracts && !options.knownContracts.includes(scenario.contract)) {
      const problem: Difference = {
        scenario: scenario.name,
        step: "-",
        pointer: "/",
        detail:
          `it is written against contract "${scenario.contract}", which is not ` +
          `one this provider still serves (${options.knownContracts.join(", ")}). ` +
          "Nothing was compared.",
      };
      differences.push(problem);
      evidence.push({
        kind: "E6-differential",
        subject: `${scenario.contract}: ${scenario.name}`,
        result: "fail",
        inputsDigest: inputsDigest(scenario),
        tool: "invariant differential",
        summary: problem.detail,
      });
      continue;
    }

    const found: Difference[] = [];
    let volatile = new Set<string>();

    try {
      const note = options.onProgress ?? (() => {});
      const started = Date.now();

      note(`${scenario.name}: starting ${scenario.contract} to calibrate`);
      const first = await withTarget(options.launch, scenario.contract, (target) =>
        observe(target, scenario, {}, compared),
      );

      await nextTick();
      note(`${scenario.name}: starting ${scenario.contract} again`);
      const second = await withTarget(options.launch, scenario.contract, (target) =>
        observe(target, scenario, {}, compared),
      );
      const declared = scenario.unordered ?? [];
      volatile = volatilePaths(
        inDeclaredOrder(first, declared),
        inDeclaredOrder(second, declared),
      );

      note(`${scenario.name}: starting the current build`);
      const head = await withTarget(options.launch, "head", (target) =>
        observe(
          target,
          scenario,
          options.contractHeader ? { [options.contractHeader]: scenario.contract } : {},
          compared,
        ),
      );
      note(
        `${scenario.name}: compared in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );

      found.push(
        ...compare(
          scenario.name,
          inDeclaredOrder(first, declared),
          inDeclaredOrder(head, declared),
          volatile,
        ),
      );
    } catch (error) {
      found.push({
        scenario: scenario.name,
        step: "-",
        pointer: "/",
        detail: `the scenario could not be run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    volatileByScenario.set(scenario.name, [...volatile].sort());

    // An acknowledgement does not make a difference disappear. It moves it to
    // a list that carries the provider's reason, so the release can proceed
    // while a reviewer still reads the sentence.
    const marked = found.map((entry) => {
      const note = scenario.acknowledged.find(
        (item) => item.step === entry.step && item.pointer === entry.pointer,
      );
      return note ? { ...entry, acknowledged: note.reason } : entry;
    });
    const open = marked.filter((entry) => entry.acknowledged === undefined);
    const accepted = marked.filter((entry) => entry.acknowledged !== undefined);

    differences.push(...open);
    acknowledgedOut.push(...accepted);

    evidence.push({
      kind: "E6-differential",
      subject: `${scenario.contract}: ${scenario.name}`,
      result: open.length > 0 ? "fail" : "pass",
      inputsDigest: inputsDigest(scenario),
      tool: "invariant differential",
      summary:
        open.length > 0
          ? `${open.length} observable differences between the old build and the new one`
          : `${scenario.steps.length} requests answered the same by both builds, ` +
            `ignoring ${volatile.size} generated values the old build did not keep stable` +
            (accepted.length > 0 ? `, with ${accepted.length} acknowledged` : ""),
      ...(open.length > 0 || accepted.length > 0
        ? {
            detail: [
              ...open.map((entry) => `${entry.step} ${entry.pointer}: ${entry.detail}`),
              ...accepted.map(
                (entry) =>
                  `acknowledged - ${entry.step} ${entry.pointer}: ${entry.detail} (${entry.acknowledged})`,
              ),
            ],
          }
        : {}),
    });
  }

  return {
    evidence,
    differences,
    acknowledged: acknowledgedOut,
    volatile: volatileByScenario,
  };
}

async function withTarget<T>(
  launch: Launcher,
  build: string,
  use: (target: Target) => Promise<T>,
): Promise<T> {
  const target = await launch(build);
  try {
    return await use(target);
  } finally {
    await target.close();
  }
}
