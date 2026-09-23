/** How much of what is left sits on APIs with no JSON or form body to adapt. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadContract,
  operationsOf,
  requestBodySchema,
  responseSchemas,
} from "@invariant-app/contract";
import { materialize, readManifest } from "./manifest.mts";

type Row = {
  api: string;
  reached: string;
  places?: { aligned: number; decided?: number; after: number };
  unexplainedDecidedPlaceKinds?: Record<string, number>;
};
const dir = process.argv[2] as string;
const rows: Row[] = [];
for (const d of readdirSync(dir))
  for (const f of readdirSync(join(dir, d)))
    if (f.endsWith(".json")) {
      const parsed = JSON.parse(readFileSync(join(dir, d, f), "utf8"));
      rows.push(...(Array.isArray(parsed) ? parsed : parsed.results));
    }
const manifest = await readManifest();
const adaptable = new Map<string, boolean>();
let aligned = 0;
let left = 0;
let alignedOut = 0;
let leftOut = 0;
for (const row of rows.filter((r) => r.reached === "done" && r.places)) {
  const here = Object.values(row.unexplainedDecidedPlaceKinds ?? {}).reduce(
    (a, b) => a + b,
    0,
  );
  aligned += row.places?.aligned ?? 0;
  left += here;
  let ok = adaptable.get(row.api);
  if (ok === undefined) {
    const pair = manifest.pairs.find((p) => p.api === row.api);
    const document = pair
      ? (await loadContract(await materialize(pair.to), "scope")).document
      : undefined;
    ok =
      document === undefined ||
      operationsOf(document).some(
        (operation) =>
          requestBodySchema(document, operation.operation) !== undefined ||
          responseSchemas(document, operation.operation).length > 0,
      );
    adaptable.set(row.api, ok);
  }
  if (!ok) {
    alignedOut += row.places?.aligned ?? 0;
    leftOut += here;
  }
}
console.log(
  `aligned ${aligned}, left ${left}; on APIs with no body Invariant adapts: aligned ${alignedOut}, left ${leftOut}`,
);
for (const [api, ok] of adaptable) if (!ok) console.log("  no adaptable body:", api);
