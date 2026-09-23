/**
 * Rig E, what the engine is told on a go-github upgrade: the operations of
 * GitHub's REST API each release calls, and which of them the API retired.
 *
 * go-github records its contract in two places, both read here as data.
 * Each method's documentation names the operations it calls
 * (`//meta:operation DELETE /repos/{owner}/{repo}/environments/...`), which
 * is the symbol map M6.1 generates for other SDKs: an operation to the method
 * that calls it. And `openapi_operations.yaml` lists every operation in the
 * GitHub descriptions the release was generated against, marking the ones
 * GitHub no longer describes as `deprecated`.
 *
 * An operation a method called in the old release, which the new release's
 * method no longer calls and which the new release lists as deprecated or not
 * at all, is an endpoint GitHub retired: the Change is `retire`, with what
 * the method calls now as the guidance. go-github 89 moved the environment
 * secret methods from `/repositories/{repository_id}/environments/...`,
 * described only for GitHub Enterprise Server 3.7, to
 * `/repos/{owner}/{repo}/environments/...`, and that is what this finds.
 *
 * The rest of what changes between go-github majors is the SDK redesigning
 * itself (a secret's name moved from a struct into a parameter; `NewClient`
 * took options), which no contract describes; the engine finds it by
 * checking the consumer against the new release, and reports it as the SDK's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Change } from "@invariant-app/ir";
import type { GoSymbol, SurfaceObject } from "@invariant-app/migrate-go";

/** Each operation a release lists, and whether it is deprecated. */
export function listedOperations(yaml: string): Map<string, { deprecated: boolean }> {
  const listed = new Map<string, { deprecated: boolean }>();
  let current: { deprecated: boolean } | undefined;
  for (const line of yaml.split("\n")) {
    const name = /^\s*- name: (\w+) (\S+)\s*$/.exec(line);
    if (name) {
      current = listed.get(`${name[1]} ${name[2]}`) ?? { deprecated: false };
      listed.set(`${name[1]} ${name[2]}`, current);
      continue;
    }
    if (current && /^\s+deprecated: true\s*$/.test(line)) current.deprecated = true;
    if (/^\S/.test(line)) current = undefined;
  }
  return listed;
}

export interface GoContract {
  changes: Change[];
  /** `delete /repos/{owner}/{repo}/...` to the methods that call it. */
  operations: Record<string, GoSymbol[]>;
}

const operationKey = (operation: string) => {
  const [method, path] = operation.split(" ");
  return `${(method ?? "").toLowerCase()} ${path ?? ""}`;
};

/** The retirements between two releases, from their surfaces and the new release's list. */
export function goGithubContract(
  before: readonly SurfaceObject[],
  after: readonly SurfaceObject[],
  newListing: string,
): GoContract {
  const listed = listedOperations(newListing);
  const later = new Map(
    after.map((object) => [`${object.package}.${object.key}`, object]),
  );
  const operations: Record<string, GoSymbol[]> = {};
  const changes: Change[] = [];
  const retired = new Set<string>();
  for (const object of before) {
    if (object.kind !== "method" || !object.operations) continue;
    const now = later.get(`${object.package}.${object.key}`)?.operations ?? [];
    for (const operation of object.operations) {
      const key = operationKey(operation);
      operations[key] = [
        ...(operations[key] ?? []),
        { package: object.package, key: object.key },
      ];
      // A release that lists nothing says nothing about what was retired.
      if (now.includes(operation) || listed.size === 0) continue;
      const status = listed.get(operation);
      if (status && !status.deprecated) continue;
      if (retired.has(key)) continue;
      retired.add(key);
      const [method, path] = key.split(" ") as [string, string];
      changes.push({
        irVersion: 1,
        id: `chg_retired_${key}`.replace(/[^\w]+/g, "_").slice(0, 120),
        summary: `GitHub no longer describes ${operation}.`,
        ops: [
          {
            op: "retire",
            endpoint: { method: method as "get", path },
            ...(now.length > 0
              ? { guidance: `\`${object.key}\` now calls ${now.join(" and ")}` }
              : {}),
          },
        ],
      });
    }
  }
  return { changes, operations };
}

/** The operations list a release of go-github ships, from its module directory. */
export function operationsListing(moduleDir: string): string {
  try {
    return readFileSync(join(moduleDir, "openapi_operations.yaml"), "utf8");
  } catch {
    return "";
  }
}
