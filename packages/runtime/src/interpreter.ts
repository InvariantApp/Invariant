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
import { compareDecimal, shiftDecimal } from "@invariant/decimal";
import { type Json, numberFromText, numberTextOf } from "./json.ts";
import {
  createSlot,
  deleteSlot,
  pruneEmptyAncestors,
  readSlot,
  resolveSlots,
  type Segments,
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
      c: string;
    }
  | { k: "cast"; path: Segments; to: ScalarType; c: string }
  | { k: "set"; path: Segments; value: Json; ifAbsent: boolean; c: string }
  | { k: "del"; path: Segments; c: string };

export class TransformError extends Error {
  readonly changeId: string;

  constructor(changeId: string, message: string) {
    super(message);
    this.name = "TransformError";
    this.changeId = changeId;
  }
}

export interface ExecuteLimits {
  /** Cap on how many slots one instruction may touch. */
  maxMatches: number;
}

export const DEFAULT_LIMITS: ExecuteLimits = { maxMatches: 10_000 };

export interface ExecuteResult {
  /** How many times each Change was actually applied. */
  applied: Map<string, number>;
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
  let moved = 0;

  for (const slot of slots) {
    const value = readSlot(slot);
    const target = createSlot(root, instr.to, slot.captures);
    if (!target) {
      throw new TransformError(
        instr.c,
        `Cannot place the value from ${instr.from.join("/")} at ${instr.to.join("/")}`,
      );
    }
    deleteSlot(slot);
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
): number {
  const slots = resolveSlots(root, instr.path, limits.maxMatches);
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
): number {
  const slots = resolveSlots(root, instr.path, limits.maxMatches);
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

function applyCast(
  root: Json,
  instr: Extract<CompiledInstr, { k: "cast" }>,
  limits: ExecuteLimits,
): number {
  const slots = resolveSlots(root, instr.path, limits.maxMatches);
  let cast = 0;

  for (const slot of slots) {
    const value = readSlot(slot);
    if (value === null) continue;
    writeSlot(slot, castValue(value, instr.to, instr, instr.path));
    cast += 1;
  }

  return cast;
}

function applySet(
  root: Json,
  instr: Extract<CompiledInstr, { k: "set" }>,
  limits: ExecuteLimits,
): number {
  // A wildcard names existing elements, but the field being written into them
  // is usually the one that does not exist yet. So resolve as far as the last
  // wildcard, then create the rest of the path inside each element found.
  const lastWildcard = instr.path.lastIndexOf("*");
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
      if (instr.ifAbsent && readSlot(target) !== undefined) continue;
      writeSlot(target, instr.value);
      written += 1;
    }
    return written;
  }

  const slot = createSlot(root, instr.path, []);
  if (!slot) {
    throw new TransformError(instr.c, `Cannot write ${instr.path.join("/")}`);
  }
  if (instr.ifAbsent && readSlot(slot) !== undefined) return 0;
  writeSlot(slot, instr.value);
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
  const result: ExecuteResult = { applied: new Map() };

  for (const instr of program) {
    switch (instr.k) {
      case "move":
        countApplied(result, instr.c, applyMove(root, instr, limits));
        break;
      case "scale":
        countApplied(result, instr.c, applyScale(root, instr, limits));
        break;
      case "enum":
        countApplied(result, instr.c, applyEnum(root, instr, limits));
        break;
      case "cast":
        countApplied(result, instr.c, applyCast(root, instr, limits));
        break;
      case "set":
        countApplied(result, instr.c, applySet(root, instr, limits));
        break;
      case "del":
        countApplied(result, instr.c, applyDel(root, instr, limits));
        break;
    }
  }

  return result;
}

export { compareDecimal };
