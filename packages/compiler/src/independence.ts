/**
 * Order independence between Changes in the same step.
 *
 * Ops inside one Change are ordered by whoever wrote it. Ops across two
 * different Changes are not: they arrive in whatever order the files were read,
 * and most of the time that is fine because they touch unrelated fields. When
 * they do touch the same place, order decides the result, and silently picking
 * one is the kind of thing that produces a transform nobody can explain later.
 *
 * So the compiler proves independence instead of assuming it, and asks for an
 * explicit order only in the cases where the answer actually depends on it.
 */
import {
  type Change,
  type DataOp,
  isDataOp,
  isSchemaScope,
  parsePointer,
} from "@invariant-app/ir";

export interface InterferenceIssue {
  changeId: string;
  message: string;
}

function pathsOf(op: DataOp): string[] {
  return op.op === "move" ? [op.from, op.to] : [op.path];
}

/** True when one pointer is the other, or sits inside it. */
function overlaps(a: string, b: string): boolean {
  const left = parsePointer(a);
  const right = parsePointer(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const x = left[i];
    const y = right[i];
    // A wildcard stands for every item or every value, so it overlaps any one.
    const any = (segment: string | undefined) => segment === "*" || segment === "{}";
    if (x !== y && !any(x) && !any(y)) return false;
  }
  return true;
}

function scopeKeys(change: Change): string[] {
  return (change.scopes ?? []).filter(isSchemaScope).map((scope) => scope.schema);
}

/**
 * Reports every pair of Changes whose result would depend on which ran first.
 */
export function findInterference(changes: readonly Change[]): InterferenceIssue[] {
  const issues: InterferenceIssue[] = [];

  for (let i = 0; i < changes.length; i += 1) {
    for (let j = i + 1; j < changes.length; j += 1) {
      const first = changes[i] as Change;
      const second = changes[j] as Change;

      const sharedScopes = scopeKeys(first).filter((scope) =>
        scopeKeys(second).includes(scope),
      );
      if (sharedScopes.length === 0) continue;

      const firstPaths = first.ops.filter(isDataOp).flatMap(pathsOf);
      const secondPaths = second.ops.filter(isDataOp).flatMap(pathsOf);

      for (const a of firstPaths) {
        for (const b of secondPaths) {
          if (!overlaps(a, b)) continue;
          issues.push({
            changeId: second.id,
            message:
              `touches ${b} in ${sharedScopes[0]}, which "${first.id}" also touches at ${a}. ` +
              "Their order changes the result, so put them in one Change or give the step an explicit order.",
          });
        }
      }
    }
  }

  return issues;
}
