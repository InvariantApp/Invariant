/**
 * Pointer navigation over data.
 *
 * The path language is JSON Pointer plus a single wildcard segment. That is
 * deliberately not expressive: there are no filters, no descendants and no
 * expressions, so the cost of an instruction is bounded by the shape of the
 * document rather than by anything the path can say.
 */

export type Segments = readonly string[];

export interface Slot {
  /** The object or array that directly holds the value. */
  container: Record<string, unknown> | unknown[];
  /** Property name, or array index as a string. */
  key: string;
  /** Wildcard positions taken to reach here, in order. */
  captures: number[];
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
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

  let frontier: { value: unknown; captures: number[] }[] = [
    { value: root, captures: [] },
  ];

  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    const segment = segments[depth] as string;
    const next: { value: unknown; captures: number[] }[] = [];

    for (const node of frontier) {
      if (!isContainer(node.value)) continue;
      if (segment === "*") {
        if (!Array.isArray(node.value)) continue;
        for (const [index, item] of node.value.entries()) {
          if (next.length >= limit) return [];
          next.push({ value: item, captures: [...node.captures, index] });
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
    if (last === "*") {
      if (!Array.isArray(node.value)) continue;
      for (const index of node.value.keys()) {
        if (slots.length >= limit) return slots;
        slots.push({
          container: node.value,
          key: String(index),
          captures: [...node.captures, index],
        });
      }
      continue;
    }
    if (Array.isArray(node.value)) continue;
    if (!Object.hasOwn(node.value, last)) continue;
    if (slots.length >= limit) return slots;
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
  captures: readonly number[],
): Slot | undefined {
  if (segments.length === 0) return undefined;

  let current = root;
  let captureIndex = 0;

  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    const raw = segments[depth] as string;
    if (!isContainer(current)) return undefined;

    if (raw === "*") {
      const index = captures[captureIndex];
      captureIndex += 1;
      if (index === undefined || !Array.isArray(current)) return undefined;
      const child = current[index];
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

  if (last === "*") {
    const index = captures[captureIndex];
    if (index === undefined || !Array.isArray(current)) return undefined;
    return { container: current, key: String(index), captures: [...captures] };
  }
  if (Array.isArray(current) || isUnsafeKey(last)) return undefined;
  return { container: current, key: last, captures: [...captures] };
}

/** Removes objects a move emptied, so the old shape does not leave a husk behind. */
export function pruneEmptyAncestors(
  root: unknown,
  segments: Segments,
  captures: readonly number[],
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
