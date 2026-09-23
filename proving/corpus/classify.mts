/**
 * Why what is left is left, by the catalogue's own class.
 *
 * The corpus says how much a run could not explain. This says what kind of
 * thing it is: a break no translation can serve, which only the provider can
 * answer for; one an op serves that nothing drafted; or one whose op is not
 * built yet. The first is a floor, the rest are work.
 *
 *   node --import tsx proving/corpus/classify.mts <directory of results>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogueEntry } from "@invariant-app/diff";

const dir = process.argv[2] as string;
const results: {
  provider: string;
  places?: { aligned: number; decided?: number; after: number };
  reached: string;
  unexplainedDecidedPlaceKinds?: Record<string, number>;
}[] = [];
for (const d of readdirSync(dir))
  for (const f of readdirSync(join(dir, d)))
    if (f.endsWith(".json")) {
      const parsed = JSON.parse(readFileSync(join(dir, d, f), "utf8"));
      results.push(...(Array.isArray(parsed) ? parsed : parsed.results));
    }
const done = results.filter((r) => r.reached === "done" && r.places);
const aligned = done.reduce((s, r) => s + (r.places?.aligned ?? 0), 0);
const byClass = new Map<string, number>();
const byKind = new Map<string, number>();
let left = 0;
for (const r of done)
  for (const [kind, n] of Object.entries(r.unexplainedDecidedPlaceKinds ?? {})) {
    const entry = catalogueEntry(kind);
    const key = `${entry.class} / served: ${entry.served}`;
    byClass.set(key, (byClass.get(key) ?? 0) + n);
    byKind.set(
      `${entry.class}|${entry.served}|${kind}`,
      (byKind.get(`${entry.class}|${entry.served}|${kind}`) ?? 0) + n,
    );
    left += n;
  }
console.log(
  `aligned ${aligned}, left after decisions ${left} (${((100 * left) / aligned).toFixed(1)}%)`,
);
for (const [key, n] of [...byClass].sort((a, b) => b[1] - a[1]))
  console.log(`${String(n).padStart(5)}  ${((100 * n) / aligned).toFixed(1)}%  ${key}`);
console.log("\nby kind:");
for (const [key, n] of [...byKind].sort((a, b) => b[1] - a[1]).slice(0, 26))
  console.log(`${String(n).padStart(5)}  ${key}`);
