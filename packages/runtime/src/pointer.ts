/**
 * Pointer navigation over data.
 *
 * The path language is JSON Pointer plus two wildcard segments: `*` for every
 * item of a list, and `{}` for every value of a map, an object whose keys are
 * data rather than field names, as Stripe's `metadata` or a price table keyed
 * by currency. That is deliberately not expressive: there are no filters, no
 * descendants and no expressions, so the cost of an instruction is bounded by
 * the shape of the document rather than by anything the path can say.
 */

export type Segments = readonly string[];

/** Every item of a list. */
export const EACH_ITEM = "*";
/** Every value of a map. */
export const EACH_VALUE = "{}";

export function isWildcard(segment: string): boolean {
  return segment === EACH_ITEM || segment === EACH_VALUE;
}

/** Where a wildcard went: a list index, or a map key. */
export type Capture = number | string;

export interface Slot {
  /** The object or array that directly holds the value. */
  container: Record<string, unknown> | unknown[];
  /** Property name, or array index as a string. */
  key: string;
  /** Wildcard positions taken to reach here, in order. */
  captures: Capture[];
}

/**
 * A path selected more slots than an instruction may touch.
 *
 * Thrown rather than returned as a short list, because a short list is a
 * partly transformed document, and a partly transformed document is a body in
 * the wrong shape that nothing reports. The interpreter attaches the Change.
 */
export class FanOutExceeded extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`more than ${limit} matches`);
    this.name = "FanOutExceeded";
    this.limit = limit;
  }
}

/**
 * Marks a value in a tree that is a leaf whatever it is made of: an XML
 * element kept whole, which no pointer may walk into or write inside.
 */
export const OPAQUE: unique symbol = Symbol("opaque");

/** Whether a value is a leaf that holds something other than JSON. */
export function isOpaque(value: unknown): boolean {
  return typeof value === "object" && value !== null && OPAQUE in value;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  // A number kept with its original digits is held as a frozen raw-JSON
  // object. It is a leaf, and treating it as an object once threw on a write
  // into it. Found by fuzzing.
  return (
    typeof value === "object" &&
    value !== null &&
    !JSON.isRawJSON(value) &&
    !(OPAQUE in value)
  );
}

/**
 * Keys that would reach outside the document being transformed.
 *
 * A program is compiled from a provider's own specification, so one of these
 * should never appear. Refusing them here anyway means a payload can never
 * steer a write onto a shared prototype, whatever produced the program.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

function readChild(container: Record<string, unknown> | unknown[], key: string): unknown {
  if (Array.isArray(container)) {
    const index = Number(key);
    return Number.isInteger(index) ? container[index] : undefined;
  }
  return container[key];
}

/**
 * Every existing slot a path selects. A path with no wildcard selects at most
 * one; a wildcard fans out across an array's elements.
 */
export function resolveSlots(root: unknown, segments: Segments, limit: number): Slot[] {
  if (segments.length === 0) return [];

  let frontier: { value: unknown; captures: Capture[] }[] = [
    { value: root, captures: [] },
  ];

  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    const segment = segments[depth] as string;
    const next: { value: unknown; captures: Capture[] }[] = [];

    for (const node of frontier) {
      if (!isContainer(node.value)) continue;
      if (segment === EACH_ITEM) {
        if (!Array.isArray(node.value)) continue;
        for (const [index, item] of node.value.entries()) {
          if (next.length >= limit) throw new FanOutExceeded(limit);
          next.push({ value: item, captures: [...node.captures, index] });
        }
        continue;
      }
      if (segment === EACH_VALUE) {
        if (Array.isArray(node.value)) continue;
        for (const key of Object.keys(node.value)) {
          if (isUnsafeKey(key)) continue;
          if (next.length >= limit) throw new FanOutExceeded(limit);
          next.push({ value: node.value[key], captures: [...node.captures, key] });
        }
        continue;
      }
      const child = readChild(node.value, segment);
      if (child === undefined) continue;
      next.push({ value: child, captures: node.captures });
    }

    frontier = next;
    if (frontier.length === 0) return [];
  }

  const last = segments[segments.length - 1] as string;
  const slots: Slot[] = [];

  for (const node of frontier) {
    if (!isContainer(node.value)) continue;
    if (last === EACH_ITEM) {
      if (!Array.isArray(node.value)) continue;
      for (const index of node.value.keys()) {
        if (slots.length >= limit) throw new FanOutExceeded(limit);
        slots.push({
          container: node.value,
          key: String(index),
          captures: [...node.captures, index],
        });
      }
      continue;
    }
    if (last === EACH_VALUE) {
      if (Array.isArray(node.value)) continue;
      for (const key of Object.keys(node.value)) {
        if (isUnsafeKey(key)) continue;
        if (slots.length >= limit) throw new FanOutExceeded(limit);
        slots.push({ container: node.value, key, captures: [...node.captures, key] });
      }
      continue;
    }
    if (Array.isArray(node.value)) continue;
    if (!Object.hasOwn(node.value, last)) continue;
    if (slots.length >= limit) throw new FanOutExceeded(limit);
    slots.push({ container: node.value, key: last, captures: node.captures });
  }

  return slots;
}

export function readSlot(slot: Slot): unknown {
  return readChild(slot.container, slot.key);
}

export function writeSlot(slot: Slot, value: unknown): void {
  if (!Array.isArray(slot.container) && isUnsafeKey(slot.key)) return;
  if (Array.isArray(slot.container)) {
    slot.container[Number(slot.key)] = value;
    return;
  }
  slot.container[slot.key] = value;
}

export function deleteSlot(slot: Slot): void {
  if (Array.isArray(slot.container)) {
    slot.container.splice(Number(slot.key), 1);
    return;
  }
  delete slot.container[slot.key];
}

/**
 * Walks to a slot, creating plain objects along the way. Wildcards are filled
 * from `captures`, so a target path lines up element by element with the source
 * path that produced it.
 */
export function createSlot(
  root: unknown,
  segments: Segments,
  captures: readonly Capture[],
): Slot | undefined {
  if (segments.length === 0) return undefined;

  let current = root;
  let captureIndex = 0;

  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    const raw = segments[depth] as string;
    if (!isContainer(current)) return undefined;

    if (raw === EACH_ITEM) {
      const index = captures[captureIndex];
      captureIndex += 1;
      if (typeof index !== "number" || !Array.isArray(current)) return undefined;
      const child = current[index];
      if (child === undefined) return undefined;
      current = child;
      continue;
    }
    if (raw === EACH_VALUE) {
      const key = captures[captureIndex];
      captureIndex += 1;
      if (typeof key !== "string" || Array.isArray(current) || isUnsafeKey(key)) {
        return undefined;
      }
      const child = Object.hasOwn(current, key) ? current[key] : undefined;
      if (child === undefined) return undefined;
      current = child;
      continue;
    }

    if (Array.isArray(current) || isUnsafeKey(raw)) return undefined;
    let child = Object.hasOwn(current, raw) ? current[raw] : undefined;
    if (child === undefined || !isContainer(child)) {
      if (child !== undefined) return undefined;
      child = {};
      current[raw] = child;
    }
    current = child;
  }

  const last = segments[segments.length - 1] as string;
  if (!isContainer(current)) return undefined;

  if (last === EACH_ITEM) {
    const index = captures[captureIndex];
    if (typeof index !== "number" || !Array.isArray(current)) return undefined;
    return { container: current, key: String(index), captures: [...captures] };
  }
  if (last === EACH_VALUE) {
    const key = captures[captureIndex];
    if (typeof key !== "string" || Array.isArray(current) || isUnsafeKey(key)) {
      return undefined;
    }
    return { container: current, key, captures: [...captures] };
  }
  if (Array.isArray(current) || isUnsafeKey(last)) return undefined;
  return { container: current, key: last, captures: [...captures] };
}

/** Removes objects a move emptied, so the old shape does not leave a husk behind. */
export function pruneEmptyAncestors(
  root: unknown,
  segments: Segments,
  captures: readonly Capture[],
): void {
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const slot = createSlot(root, segments.slice(0, depth), captures);
    if (!slot) return;
    const value = readSlot(slot);
    const empty =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0;
    if (!empty) return;
    deleteSlot(slot);
  }
}
