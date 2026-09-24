/**
 * Source edits as byte ranges.
 *
 * Nothing here reprints an AST. A codemod produces a replacement for an exact
 * span, and everything outside that span is left untouched, so a migration diff
 * contains only lines that actually had to change. A pull request that also
 * reformats half a file is one nobody reads properly.
 *
 * Edits nest, because call sites nest: `amount: charge.amount` is a write whose
 * value is itself a read, and both moved. An inner edit is applied first and
 * the outer one is handed the result, so the outer rewrite is composed against
 * migrated text rather than against text that no longer exists.
 */

/** Produces the replacement from the span's text, after inner edits have run. */
export type Replacement = string | ((inner: string) => string);

export interface Edit {
  file: string;
  start: number;
  end: number;
  replacement: Replacement;
  /** The Change this edit exists because of. */
  changeId: string;
  /** Who wrote it: a codemod, or a model asked to repair what codemods could not. */
  author: "codemod" | "model";
  /** A short description for the pull request body. */
  reason: string;
}

export class ConflictingEditsError extends Error {
  constructor(file: string, a: Edit, b: Edit) {
    super(
      `Two edits overlap without nesting in ${file}: ${a.changeId} at ${a.start}-${a.end} ` +
        `and ${b.changeId} at ${b.start}-${b.end}`,
    );
    this.name = "ConflictingEditsError";
  }
}

function contains(outer: Edit, inner: Edit): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function overlaps(a: Edit, b: Edit): boolean {
  return a.start < b.end && b.start < a.end;
}

interface Tree {
  edit: Edit;
  children: Tree[];
}

/** Groups edits by containment, so an inner rewrite runs before the outer one. */
function buildTrees(file: string, edits: readonly Edit[]): Tree[] {
  // Widest first, and at equal width the earlier one, so a parent is always
  // seen before anything it contains.
  const ordered = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);

  const roots: Tree[] = [];
  const stack: Tree[] = [];

  for (const edit of ordered) {
    while (stack.length > 0 && !contains((stack[stack.length - 1] as Tree).edit, edit)) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent && overlaps(parent.edit, edit) && !contains(parent.edit, edit)) {
      throw new ConflictingEditsError(file, parent.edit, edit);
    }
    const sibling = (parent ? parent.children : roots).at(-1);
    if (sibling && overlaps(sibling.edit, edit)) {
      throw new ConflictingEditsError(file, sibling.edit, edit);
    }

    const node: Tree = { edit, children: [] };
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  }

  return roots;
}

function resolve(node: Tree, text: string): string {
  const { edit } = node;
  let span = text.slice(edit.start, edit.end);

  // Children are applied back to front, so each one's offsets still refer to
  // the text it was computed against.
  for (const child of [...node.children].sort((a, b) => b.edit.start - a.edit.start)) {
    const resolved = resolve(child, text);
    span =
      span.slice(0, child.edit.start - edit.start) +
      resolved +
      span.slice(child.edit.end - edit.start);
  }

  return typeof edit.replacement === "string" ? edit.replacement : edit.replacement(span);
}

export function applyEdits(file: string, text: string, edits: readonly Edit[]): string {
  const roots = buildTrees(file, edits);

  let out = text;
  for (const root of [...roots].sort((a, b) => b.edit.start - a.edit.start)) {
    out = out.slice(0, root.edit.start) + resolve(root, text) + out.slice(root.edit.end);
  }
  return out;
}

export function groupByFile(edits: readonly Edit[]): Map<string, Edit[]> {
  const byFile = new Map<string, Edit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? [];
    list.push(edit);
    byFile.set(edit.file, list);
  }
  return byFile;
}

/**
 * Where an offset in the edited text was before the edits: shifted back by
 * every edit wholly before it, and to the start of an edit it falls inside.
 */
export function originalOffset(offset: number, edits: readonly Edit[]): number {
  let shift = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    const replacement =
      typeof edit.replacement === "string" ? edit.replacement : edit.replacement("");
    const newStart = edit.start + shift;
    const newEnd = newStart + replacement.length;
    if (offset < newStart) break;
    if (offset < newEnd) return edit.start;
    shift += replacement.length - (edit.end - edit.start);
  }
  return offset - shift;
}
