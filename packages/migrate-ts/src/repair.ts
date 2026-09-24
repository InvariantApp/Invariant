/**
 * Assisted repair: a model asked to finish what the codemods left to a person.
 *
 * The consumer's source is theirs. A model is sent the Change, why the site
 * was left, and the one function the site is in, as the migration left it:
 * never the rest of the file, never another file, and nothing at all for a
 * site outside any function. Whoever runs the migration decides whether a
 * model is asked at all (`repair` absent means never, which is how an
 * integration that asked for it to be off gets it off), and this package only
 * hands the request to what it is given; it sends nothing anywhere itself.
 *
 * What comes back may replace that function and nothing else. It is kept only
 * if it is still one function of the same kind in the same place, and the
 * file has no type error it did not have before; otherwise the site stays
 * with a person, exactly as it was reported.
 */
import { relative } from "node:path";
import type { Change } from "@invariant-app/ir";
import { type Edit, type ManualSite, originalOffset } from "@invariant-app/migrate-core";
import { Node, type Project, type SourceFile } from "ts-morph";

export interface RepairRequest {
  /** The Change the site exists because of, as the provider wrote it. */
  change: Change | undefined;
  /** Why the site was left to a person, one line for each site in the function. */
  reasons: string[];
  /** The file, relative to the repository, so the model is not told where it is checked out. */
  file: string;
  /** The enclosing function as the migration left it, and nothing else of the file. */
  enclosing: string;
}

/** Asks a model for the whole function, rewritten; nothing means no answer. */
export type Repairer = (request: RepairRequest) => Promise<string | undefined>;

/** A function a model rewrote, and the migration kept. */
export interface Repair {
  file: string;
  changeId: string;
  /** The span it replaced, in the file as the codemods left it. */
  start: number;
  end: number;
  replacement: string;
  author: "model";
}

type FunctionLike = Node;

function isFunctionLike(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

/**
 * The innermost function whose text, mapped back through the edits, holds the
 * site as it was read. The site's offset is into the file before any edit.
 */
function enclosingFunction(
  source: SourceFile,
  offset: number,
  edits: readonly Edit[],
): FunctionLike | undefined {
  let found: FunctionLike | undefined;
  source.forEachDescendant((node) => {
    if (!isFunctionLike(node)) return;
    const start = originalOffset(node.getStart(), edits);
    const end = originalOffset(node.getEnd(), edits);
    if (start <= offset && offset < end) {
      // Descendants come after their ancestors, so the last match is innermost.
      found = node;
    }
  });
  return found;
}

/** Each type error in a file, without its line, counted, so moved lines are not new ones. */
function errorsIn(source: SourceFile): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of source.getPreEmitDiagnostics()) {
    const text = diagnostic.getMessageText();
    const key = `TS${diagnostic.getCode()} ${typeof text === "string" ? text : text.getMessageText()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function noNewErrors(before: Map<string, number>, after: Map<string, number>): boolean {
  for (const [key, count] of after) {
    if (count > (before.get(key) ?? 0)) return false;
  }
  return true;
}

/**
 * Offers each function with a site left to a person to `repair`, keeps what
 * holds, and takes the sites it settled off `manual`.
 *
 * `files` holds each edited file's text and is updated in place, as is the
 * project, so what is written and checked afterwards includes the repairs.
 */
export async function assistRepair(options: {
  project: Project;
  repoDir: string;
  generated: readonly string[];
  changes: readonly Change[];
  manual: ManualSite[];
  edits: readonly Edit[];
  files: Map<string, string>;
  repair: Repairer;
}): Promise<Repair[]> {
  const { project, files } = options;
  const byFunction = new Map<
    string,
    { file: string; start: number; end: number; kind: number; sites: ManualSite[] }
  >();
  for (const site of options.manual) {
    if (options.generated.some((entry) => site.file.startsWith(entry))) continue;
    const source = project.getSourceFile(site.file);
    if (!source) continue;
    const edits = options.edits.filter((edit) => edit.file === site.file);
    const node = enclosingFunction(source, site.offset, edits);
    // Outside every function there is nothing small enough to send.
    if (!node) continue;
    const key = `${site.file}:${node.getStart()}`;
    const entry = byFunction.get(key) ?? {
      file: site.file,
      start: node.getStart(),
      end: node.getEnd(),
      kind: node.getKind(),
      sites: [],
    };
    entry.sites.push(site);
    byFunction.set(key, entry);
  }

  // Back to front within a file, so a function rewritten does not move the
  // ones before it.
  const pending = [...byFunction.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || b.start - a.start,
  );
  const repairs: Repair[] = [];
  const settled = new Set<ManualSite>();
  for (const entry of pending) {
    const source = project.getSourceFileOrThrow(entry.file);
    const text = source.getFullText();
    const enclosing = text.slice(entry.start, entry.end);
    const first = entry.sites[0] as ManualSite;
    const reply = await options.repair({
      change: options.changes.find((change) => change.id === first.changeId),
      reasons: entry.sites.map((site) => site.reason),
      file: relative(options.repoDir, entry.file),
      enclosing,
    });
    const answer = reply?.trim();
    if (answer === undefined || answer === "" || answer === enclosing) continue;

    const before = errorsIn(source);
    const updated = text.slice(0, entry.start) + answer + text.slice(entry.end);
    source.replaceWithText(updated);
    const replaced = source.getDescendantAtStartWithWidth(entry.start, answer.length);
    const kept =
      replaced !== undefined &&
      replaced.getKind() === entry.kind &&
      noNewErrors(before, errorsIn(source));
    if (!kept) {
      source.replaceWithText(text);
      continue;
    }
    files.set(entry.file, updated);
    for (const site of entry.sites) settled.add(site);
    // A site left below the function moves by the lines the rewrite added.
    const lines = answer.split("\n").length - enclosing.split("\n").length;
    const edits = options.edits.filter((edit) => edit.file === entry.file);
    const after = originalOffset(entry.end, edits);
    for (const site of options.manual) {
      if (site.file === entry.file && !settled.has(site) && site.offset >= after) {
        site.line += lines;
      }
    }
    repairs.push({
      file: entry.file,
      changeId: first.changeId,
      start: entry.start,
      end: entry.end,
      replacement: answer,
      author: "model",
    });
  }

  const left = options.manual.filter((site) => !settled.has(site));
  options.manual.splice(0, options.manual.length, ...left);
  return repairs;
}
