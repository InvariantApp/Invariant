/**
 * The compatibility interpreter.
 *
 * Six instructions, no loops, no recursion over user input beyond the depth of
 * the document, no expressions, no I/O. There is nothing here that can be made
 * to call out, and nothing that a payload can steer. A program is data, and the
 * worst a malformed one can do is fail.
 *
 * Failure is always loud. A transform that cannot be completed exactly must
 * never hand back a body in the wrong shape, so every refusal raises rather
 * than skipping the instruction.
 */
import { compareDecimal, DecimalError, shiftDecimal } from "@invariant-app/decimal";
import {
  CodecRefusal,
  convertCase,
  convertTime,
  type StringCase,
  type TimeFormat,
} from "./codecs.ts";
import { isNumberLike, type Json, numberFromText, numberTextOf } from "./json.ts";
import {
  createSlot,
  deleteSlot,
  FanOutExceeded,
  isOpaque,
  isWildcard,
  pruneEmptyAncestors,
  readSlot,
  resolveSlots,
  type Segments,
  type Slot,
  writeSlot,
} from "./pointer.ts";

export type ScalarType = "string" | "integer" | "number" | "boolean";

export type CompiledInstr =
  | { k: "move"; from: Segments; to: Segments; c: string }
  | { k: "scale"; path: Segments; exp: number; c: string }
  | {
      k: "enum";
      path: Segments;
      map: Record<string, string>;
      lenient?: boolean;
      /**
       * Keys of `map` that are folds rather than renames: values the new
       * contract can produce that the old one cannot name, substituted with one
       * it can. Carried separately because a fold is a small lie the caller has
       * no way to detect, and the runtime owes them a way to find out.
       */
      folded?: string[];
      c: string;
    }
  | { k: "cast"; path: Segments; to: ScalarType; c: string }
  | {
      k: "time";
      path: Segments;
      from: TimeFormat;
      to: TimeFormat;
      truncate?: boolean;
      c: string;
    }
  | { k: "case"; path: Segments; from: StringCase; to: StringCase; c: string }
  | { k: "wrap"; path: Segments; c: string }
  | { k: "unwrap"; path: Segments; first?: boolean; c: string }
  | { k: "drop"; path: Segments; values: ReadonlySet<string>; c: string }
  | {
      k: "set";
      path: Segments;
      value: Json;
      ifAbsent: boolean;
      ifNull?: boolean;
      c: string;
    }
  | { k: "del"; path: Segments; ifNull?: boolean; c: string }
  | { k: "within"; path: Segments; block: CompiledInstr[]; c: string }
  | { k: "switch"; path: Segments; cases: Map<string, CompiledInstr[]>; c: string }
  | { k: "has"; path: Segments; block: CompiledInstr[]; absent?: boolean; c: string }
  | { k: "is"; path: Segments; type: JsonKind; block: CompiledInstr[]; c: string }
  | {
      k: "call";
      name: string;
      /**
       * The named block, shared by every call to it. Filled in once every
       * block of the contract is decoded, so a block can call itself.
       */
      target: { instrs: CompiledInstr[] };
      c: string;
    };

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

/**
 * How deeply calls may nest while running one body. A call only goes deeper
 * inside a `within` that descends into the value, and bodies are refused past
 * 256 levels, so this is never reached by a program the decoder accepts; it
 * is the guard behind that proof.
 */
const MAX_CALL_DEPTH = 512;

/** The JSON kind of a parsed value. */
function kindOf(value: unknown): JsonKind | undefined {
  if (value === null) return "null";
  // An XML element kept whole is no kind of JSON value.
  if (isOpaque(value)) return undefined;
  if (isNumberLike(value)) return "number";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return undefined;
  }
}

/**
 * Every place an instruction reads or writes, from the root it runs at,
 * including what its blocks touch: a block under `within` is read from each
 * match, which a wildcard stands for here.
 *
 * A named block is followed once per path through the calls: where it recurs,
 * it touches deeper copies of places already listed, so the list stays finite
 * and still names every place at each depth it was first reached.
 */
export function touchedPaths(
  instr: CompiledInstr,
  entered: ReadonlySet<string> = new Set(),
): Segments[] {
  const inner = (block: readonly CompiledInstr[]) =>
    block.flatMap((each) => touchedPaths(each, entered));
  switch (instr.k) {
    case "move":
      return [instr.from, instr.to];
    case "within":
      return [instr.path, ...inner(instr.block).map((path) => [...instr.path, ...path])];
    case "switch":
      return [instr.path, ...[...instr.cases.values()].flatMap(inner)];
    case "has":
    case "is":
      return [instr.path, ...inner(instr.block)];
    case "call": {
      if (entered.has(instr.name)) return [];
      const deeper = new Set(entered).add(instr.name);
      return instr.target.instrs.flatMap((each) => touchedPaths(each, deeper));
    }
    default:
      return [instr.path];
  }
}

export class TransformError extends Error {
  readonly changeId: string;

  constructor(changeId: string, message: string) {
    super(message);
    this.name = "TransformError";
    this.changeId = changeId;
  }
}

/**
 * An instruction matched more places than the configured cap allows.
 *
 * A request carrying this is refused as too large; a response carrying it is
 * refused as untranslatable. Neither is ever answered with a body that was
 * transformed in part.
 */
export class MatchLimitError extends TransformError {
  readonly limit: number;

  constructor(changeId: string, limit: number) {
    super(
      changeId,
      `${changeId} would touch more than ${limit} places in one body. Raise ` +
        "limits.maxMatches if bodies this large are expected.",
    );
    this.name = "MatchLimitError";
    this.limit = limit;
  }
}

export interface ExecuteLimits {
  /** Cap on how many slots one instruction may touch. */
  maxMatches: number;
  /**
   * Most milliseconds one body may take, checked as it runs. A pathological
   * body, deep recursion through a schema that contains itself, cannot hold
   * a worker past it. Absent means no limit.
   */
  timeBudgetMs?: number;
}

export const DEFAULT_LIMITS: ExecuteLimits = { maxMatches: 10_000, timeBudgetMs: 100 };

/** Too long spent on one body: refused as too large to translate, never finished late. */
export class TimeBudgetError extends TransformError {
  readonly budgetMs: number;

  constructor(changeId: string, budgetMs: number) {
    super(
      changeId,
      `${changeId} was still running after ${budgetMs} ms on one body. Raise ` +
        "limits.timeBudgetMs if bodies this large are expected.",
    );
    this.name = "TimeBudgetError";
    this.budgetMs = budgetMs;
  }
}

/** The clock one body runs against, read every so many steps so it costs nothing. */
interface Clock {
  deadline: number;
  ticks: number;
}
class TimeExceeded extends Error {}
const TICKS_PER_READ = 256;

export interface ExecuteResult {
  /** How many times each Change was actually applied. */
  applied: Map<string, number>;
  /**
   * Where a value was folded: shown to the caller as one their contract names,
   * when the API actually produced one it does not. Paths, joined with `/`.
   */
  folded: Set<string>;
}

function countApplied(result: ExecuteResult, changeId: string, times: number): void {
  if (times === 0) return;
  result.applied.set(changeId, (result.applied.get(changeId) ?? 0) + times);
}

function applyMove(
  root: Json,
  instr: Extract<CompiledInstr, { k: "move" }>,
  limits: ExecuteLimits,
): number {
  const slots = resolveSlots(root, instr.from, limits.maxMatches);
  // A value moved beneath its own place, as Meilisearch's list of a rule's
  // actions became the `pin` list of an object in its place, leaves that
  // place first, so the object can be built there.
  const beneath =
    instr.to.length > instr.from.length &&
    instr.from.every((segment, index) => segment === instr.to[index]);
  let moved = 0;

  for (const slot of slots) {
    const value = readSlot(slot);
    if (beneath) deleteSlot(slot);
    const target = createSlot(root, instr.to, slot.captures);
    if (!target) {
      throw new TransformError(
        instr.c,
        `Cannot place the value from ${instr.from.join("/")} at ${instr.to.join("/")}`,
      );
    }
    if (!beneath) deleteSlot(slot);
    writeSlot(target, value);
    pruneEmptyAncestors(root, instr.from, slot.captures);
    moved += 1;
  }

  return moved;
}

function applyScale(
  root: Json,
  instr: Extract<CompiledInstr, { k: "scale" }>,
  limits: ExecuteLimits,
  here: Here | undefined,
): number {
  const slots = slotsAt(root, instr.path, limits, here);
  let scaled = 0;

  for (const slot of slots) {
    const value = readSlot(slot);
    if (value === null) continue;
    let text: string;
    try {
      text = numberTextOf(value);
    } catch {
      throw new TransformError(
        instr.c,
        `Expected a number at ${instr.path.join("/")} to scale, found ${typeof value}`,
      );
    }

    const shifted = shiftDecimal(text, instr.exp);
    // Scaling up is only meaningful if the value really carried no more
    // precision than the contract promised. Rounding here would silently
    // change an amount, so an inexact value is refused instead.
    if (instr.exp > 0 && shifted.includes(".")) {
      throw new TransformError(
        instr.c,
        `Value ${text} at ${instr.path.join("/")} has more precision than the contract allows`,
      );
    }
    writeSlot(slot, numberFromText(shifted));
    scaled += 1;
  }

  return scaled;
}

function applyEnum(
  root: Json,
  instr: Extract<CompiledInstr, { k: "enum" }>,
  limits: ExecuteLimits,
  here: Here | undefined,
  folded: Set<string>,
): number {
  const folds = instr.folded === undefined ? undefined : new Set(instr.folded);
  const slots = slotsAt(root, instr.path, limits, here);
  let mapped = 0;

  for (const slot of slots) {
    const value = readSlot(slot);
    if (value === null) continue;
    if (typeof value !== "string") {
      throw new TransformError(
        instr.c,
        `Expected a string at ${instr.path.join("/")} to map, found ${typeof value}`,
      );
    }
    const replacement = Object.hasOwn(instr.map, value) ? instr.map[value] : undefined;
    if (replacement === undefined) {
      // A value that is part of the contract has no name here, so the response
      // cannot be expressed and saying so is the only honest option. A lenient
      // mapping is a diagnostic label rather than contract data, and an
      // unfamiliar one is better passed through than turned into a failure.
      if (instr.lenient) continue;
      throw new TransformError(
        instr.c,
        `No mapping for "${value}" at ${instr.path.join("/")} in this contract`,
      );
    }
    if (folds?.has(value)) folded.add(instr.path.join("/"));
    writeSlot(slot, replacement);
    mapped += 1;
  }

  return mapped;
}

function castValue(
  value: unknown,
  to: ScalarType,
  instr: CompiledInstr,
  path: Segments,
): unknown {
  switch (to) {
    case "string":
      if (typeof value === "string") return value;
      if (typeof value === "boolean") return String(value);
      if (!isNumberLike(value)) {
        throw new TransformError(
          instr.c,
          `Cannot cast ${value === null ? "null" : typeof value} to string at ${path.join("/")}`,
        );
      }
      return numberTextOf(value);
    case "boolean":
      if (typeof value === "boolean") return value;
      throw new TransformError(
        instr.c,
        `Cannot cast ${typeof value} to boolean at ${path.join("/")}`,
      );
    case "integer":
    case "number": {
      const text = typeof value === "string" ? value : numberTextOf(value);
      const normalized = shiftDecimal(text, 0);
      if (to === "integer" && normalized.includes(".")) {
        throw new TransformError(
          instr.c,
          `Value ${text} at ${path.join("/")} is not an integer`,
        );
      }
      return numberFromText(normalized);
    }
  }
}

/** What a codec returns to take the field away rather than rewrite it. */
const LEAVE_OUT: unique symbol = Symbol("leave out");

/**
 * Rewrites each value at the path with a codec that is exact or refuses. A
 * null passes through, as it does for every codec: a nullable field stays
 * nullable on both sides.
 */
function applyEach(
  root: Json,
  instr: Extract<CompiledInstr, { k: "time" | "case" | "wrap" | "unwrap" | "drop" }>,
  limits: ExecuteLimits,
  here: Here | undefined,
  convert: (value: unknown) => unknown,
): number {
  let done = 0;
  const removals: Slot[] = [];
  for (const slot of slotsAt(root, instr.path, limits, here)) {
    const value = readSlot(slot);
    if (value === null) continue;
    let converted: unknown;
    try {
      converted = convert(value);
    } catch (error) {
      if (!(error instanceof CodecRefusal)) throw error;
      throw new TransformError(instr.c, `At ${instr.path.join("/")}, ${error.message}`);
    }
    if (converted === LEAVE_OUT) removals.push(slot);
    else writeSlot(slot, converted);
    done += 1;
  }
  // Back to front, so taking one list item out never moves the next.
  for (const slot of removals.reverse()) deleteSlot(slot);
  return done;
}

function unwrapped(value: unknown, first: boolean): unknown {
  if (!Array.isArray(value)) {
    throw new CodecRefusal(`expected a list to unwrap, found ${typeof value}`);
  }
  if (first) return value.length === 0 ? LEAVE_OUT : value[0];
  if (value.length !== 1) {
    // The old contract holds one value. It cannot say that there are none,
    // and choosing one of several would hide the rest.
    throw new CodecRefusal(
      `the list holds ${value.length} items, and only one can be shown`,
    );
  }
  return value[0];
}

/**
 * A list without the values the new contract no longer accepts, its other
 * items in their order. Asana stopped offering fields an old caller could ask
 * for in `opt_fields`, and asking for one refused the whole request.
 */
function withoutValues(value: unknown, values: ReadonlySet<string>): unknown {
  if (!Array.isArray(value)) {
    throw new CodecRefusal(
      `expected a list to take values out of, found ${typeof value}`,
    );
  }
  return value.filter((item) => typeof item !== "string" || !values.has(item));
}

function applyCast(
  root: Json,
  instr: Extract<CompiledInstr, { k: "cast" }>,
  limits: ExecuteLimits,
  here: Here | undefined,
): number {
  const slots = slotsAt(root, instr.path, limits, here);
  let cast = 0;

  for (const slot of slots) {
    const value = readSlot(slot);
    if (value === null) continue;
    writeSlot(slot, castValue(value, instr.to, instr, instr.path));
    cast += 1;
  }

  return cast;
}

/** Whether a `set` writes over what is there now. */
function setsOver(
  instr: Extract<CompiledInstr, { k: "set" }>,
  current: unknown,
): boolean {
  if (!instr.ifAbsent && !instr.ifNull) return true;
  return (
    (instr.ifAbsent && current === undefined) ||
    (instr.ifNull === true && current === null)
  );
}

/**
 * A value a program writes, as a copy of its own. Written as it stands, one
 * object would be shared by every place it lands and by the program itself,
 * so an instruction that writes into one of them, as Meilisearch's restored
 * `action` has its `type` put back, would write into all of them and into
 * every later answer. The Go engine has always copied it.
 */
function fresh(value: Json): Json {
  if (Array.isArray(value)) return value.map(fresh);
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, Json>).map(([key, entry]) => [
        key,
        fresh(entry),
      ]),
    );
  }
  return value;
}

function applySet(
  root: Json,
  instr: Extract<CompiledInstr, { k: "set" }>,
  limits: ExecuteLimits,
): number {
  // Filling a null never creates a field: only values that are there, and
  // null, are written over.
  if (instr.ifNull && !instr.ifAbsent) {
    let written = 0;
    for (const slot of resolveSlots(root, instr.path, limits.maxMatches)) {
      if (readSlot(slot) !== null) continue;
      writeSlot(slot, fresh(instr.value));
      written += 1;
    }
    return written;
  }

  // A wildcard names existing elements, but the field being written into them
  // is usually the one that does not exist yet. So resolve as far as the last
  // wildcard, then create the rest of the path inside each element found.
  const lastWildcard = instr.path.findLastIndex(isWildcard);
  if (lastWildcard >= 0) {
    const elements = resolveSlots(
      root,
      instr.path.slice(0, lastWildcard + 1),
      limits.maxMatches,
    );
    const rest = instr.path.slice(lastWildcard + 1);
    let written = 0;

    for (const element of elements) {
      const target =
        rest.length === 0 ? element : createSlot(readSlot(element), rest, []);
      if (!target) continue;
      if (!setsOver(instr, readSlot(target))) continue;
      writeSlot(target, fresh(instr.value));
      written += 1;
    }
    return written;
  }

  const slot = createSlot(root, instr.path, []);
  if (!slot) {
    throw new TransformError(instr.c, `Cannot write ${instr.path.join("/")}`);
  }
  if (!setsOver(instr, readSlot(slot))) return 0;
  writeSlot(slot, fresh(instr.value));
  return 1;
}

function applyDel(
  root: Json,
  instr: Extract<CompiledInstr, { k: "del" }>,
  limits: ExecuteLimits,
): number {
  const slots = resolveSlots(root, instr.path, limits.maxMatches);
  // Deleting from an array shifts later indices, so work back to front.
  let removed = 0;
  for (const slot of [...slots].reverse()) {
    if (instr.ifNull && readSlot(slot) !== null) continue;
    deleteSlot(slot);
    removed += 1;
  }
  return removed;
}

/**
 * Runs a program over a parsed body, in place.
 *
 * A path that is simply absent is not an error: optional fields are allowed to
 * be missing, and an instruction that matches nothing has nothing to do. A path
 * that is present but holds the wrong kind of value is an error, because that
 * means the document does not match the contract the program was compiled for.
 */
export function execute(
  root: Json,
  program: readonly CompiledInstr[],
  limits: ExecuteLimits = DEFAULT_LIMITS,
): ExecuteResult {
  const result: ExecuteResult = { applied: new Map(), folded: new Set() };
  const bounded: ExecuteLimits & Partial<Clock> =
    limits.timeBudgetMs === undefined || !Number.isFinite(limits.timeBudgetMs)
      ? limits
      : { ...limits, deadline: performance.now() + limits.timeBudgetMs, ticks: 0 };

  for (const instr of program) {
    try {
      step(root, instr, bounded, result, 0, undefined);
      // Read after every instruction as well as every so many steps. One
      // instruction can move ten thousand places, and a program shorter than
      // the step interval never read the clock at all: sixty moves over nine
      // thousand items ran for more than a second against a five millisecond
      // budget. Found by the threat-model tests.
      if (bounded.deadline !== undefined && performance.now() > bounded.deadline) {
        throw new TimeExceeded();
      }
    } catch (error) {
      if (error instanceof FanOutExceeded)
        throw new MatchLimitError(instr.c, error.limit);
      if (error instanceof TimeExceeded) {
        throw new TimeBudgetError(instr.c, limits.timeBudgetMs ?? 0);
      }
      // Decimal arithmetic on a value this change cannot express, such as a
      // cast of "abc" to a number: the body is not translatable by it.
      if (error instanceof DecimalError) throw new TransformError(instr.c, error.message);
      throw error;
    }
  }

  return result;
}

/**
 * Where the value a block runs on is held, when a `within` descended to it.
 * An instruction whose path is empty writes the value itself through it:
 * replacing it, or removing it from its container once the `within` is done.
 */
interface Here {
  slot: Slot;
  removals: Slot[];
}

/**
 * The places an instruction's path names. An empty path names the value a
 * `within` descended to, which a value such as a nullable enum can be: the
 * instruction rewrites it where it is held.
 */
function slotsAt(
  root: Json,
  path: Segments,
  limits: ExecuteLimits,
  here: Here | undefined,
): Slot[] {
  if (path.length === 0) return here ? [here.slot] : [];
  return resolveSlots(root, path, limits.maxMatches);
}

/** The value a block runs on, as it reads now, after what earlier instructions wrote. */
function current(root: Json, here: Here | undefined): unknown {
  return here ? readSlot(here.slot) : root;
}

function hereFor(instr: CompiledInstr, here: Here | undefined): Here {
  if (!here) {
    throw new TransformError(instr.c, "An instruction cannot replace a whole body");
  }
  return here;
}

function step(
  root: Json,
  instr: CompiledInstr,
  limits: ExecuteLimits & Partial<Clock>,
  result: ExecuteResult,
  calls: number,
  here: Here | undefined,
): void {
  if (limits.deadline !== undefined) {
    limits.ticks = (limits.ticks ?? 0) + 1;
    if (limits.ticks % TICKS_PER_READ === 0 && performance.now() > limits.deadline) {
      throw new TimeExceeded();
    }
  }
  const run = (
    at: Json,
    block: readonly CompiledInstr[],
    depth = calls,
    where: Here | undefined = here,
  ) => {
    for (const inner of block) step(at, inner, limits, result, depth, where);
  };
  switch (instr.k) {
    case "move":
      if (instr.to.length === 0) {
        // The value becomes what it holds at `from`, as an object becomes its id.
        const [source] = resolveSlots(root, instr.from, limits.maxMatches);
        if (source === undefined) break;
        writeSlot(hereFor(instr, here).slot, readSlot(source));
        countApplied(result, instr.c, 1);
        break;
      }
      countApplied(result, instr.c, applyMove(root, instr, limits));
      break;
    case "scale":
      countApplied(result, instr.c, applyScale(root, instr, limits, here));
      break;
    case "enum":
      countApplied(result, instr.c, applyEnum(root, instr, limits, here, result.folded));
      break;
    case "cast":
      countApplied(result, instr.c, applyCast(root, instr, limits, here));
      break;
    case "time":
      countApplied(
        result,
        instr.c,
        applyEach(root, instr, limits, here, (value) =>
          convertTime(value, instr.from, instr.to, instr.truncate === true),
        ),
      );
      break;
    case "case":
      countApplied(
        result,
        instr.c,
        applyEach(root, instr, limits, here, (value) =>
          convertCase(value, instr.from, instr.to),
        ),
      );
      break;
    case "wrap":
      countApplied(
        result,
        instr.c,
        applyEach(root, instr, limits, here, (value) => [value]),
      );
      break;
    case "unwrap":
      countApplied(
        result,
        instr.c,
        applyEach(root, instr, limits, here, (value) =>
          unwrapped(value, instr.first === true),
        ),
      );
      break;
    case "drop":
      countApplied(
        result,
        instr.c,
        applyEach(root, instr, limits, here, (value) =>
          withoutValues(value, instr.values),
        ),
      );
      break;
    case "set":
      if (instr.path.length === 0) {
        writeSlot(hereFor(instr, here).slot, fresh(instr.value));
        countApplied(result, instr.c, 1);
        break;
      }
      countApplied(result, instr.c, applySet(root, instr, limits));
      break;
    case "del":
      if (instr.path.length === 0) {
        const at = hereFor(instr, here);
        at.removals.push(at.slot);
        countApplied(result, instr.c, 1);
        break;
      }
      countApplied(result, instr.c, applyDel(root, instr, limits));
      break;
    case "within": {
      // The block runs at each match, reading its pointers from there.
      if (instr.path.length === 0) {
        if (
          here ||
          (typeof root === "object" && root !== null && !JSON.isRawJSON(root))
        ) {
          run(root, instr.block);
        }
        break;
      }
      const removals: Slot[] = [];
      for (const slot of resolveSlots(root, instr.path, limits.maxMatches)) {
        // A scalar too: the block's empty paths name it, and rewrite it in place.
        run(readSlot(slot) as Json, instr.block, calls, { slot, removals });
      }
      // Back to front, so removing one list item never moves the next.
      for (const slot of removals.reverse()) deleteSlot(slot);
      break;
    }
    case "switch": {
      // Read once, before anything in the chosen block can change it.
      const value =
        instr.path.length === 0
          ? current(root, here)
          : readOne(root, instr.path, limits.maxMatches);
      const key =
        typeof value === "string"
          ? value
          : typeof value === "boolean"
            ? String(value)
            : isNumberLike(value)
              ? numberTextOf(value)
              : undefined;
      const block = key === undefined ? undefined : instr.cases.get(key);
      run(root, block ?? []);
      break;
    }
    case "has": {
      const present = resolveSlots(root, instr.path, limits.maxMatches).length > 0;
      if (present === (instr.absent === true)) break;
      run(root, instr.block);
      break;
    }
    case "is": {
      const value =
        instr.path.length === 0
          ? current(root, here)
          : readOne(root, instr.path, limits.maxMatches);
      if (value !== undefined && kindOf(value) === instr.type) run(root, instr.block);
      break;
    }
    case "call": {
      if (calls >= MAX_CALL_DEPTH) {
        throw new TransformError(instr.c, `${instr.name} called itself too deeply`);
      }
      run(root, instr.target.instrs, calls + 1);
      break;
    }
  }
}

function readOne(root: Json, path: Segments, limit: number): unknown {
  const [slot] = resolveSlots(root, path, limit);
  return slot === undefined ? undefined : readSlot(slot);
}

export { compareDecimal };
