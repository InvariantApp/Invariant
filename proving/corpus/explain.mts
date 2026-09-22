/**
 * What is still unexplained once every decision is answered, place by place,
 * for reading closely: the corpus run keeps only counts.
 *
 *   node --import tsx proving/corpus/explain.mts --provider stripe.com [--limit 3] [--kind <id>]
 *
 * Pairs run one at a time in this process, so keep --limit small on large
 * providers and run it under `capped`.
 */
import { analysePair, placeOf } from "@invariant-app/eval";
import { RulesJudge } from "@invariant-app/proposer";
import { materialize, readManifest } from "./manifest.mts";

const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const provider = option("provider");
const api = option("api");
const kind = option("kind");
const limit = Number(option("limit") ?? 5);
const skip = Number(option("skip") ?? 0);

const manifest = await readManifest();
const pairs = manifest.pairs
  .filter(
    (pair) =>
      (provider === undefined || pair.provider === provider) &&
      (api === undefined || pair.api === api),
  )
  .slice(skip, skip + limit);

const byKind = new Map<string, Map<string, number>>();
for (const pair of pairs) {
  const result = await analysePair(
    {
      api: pair.api,
      fromVersion: pair.from.label,
      toVersion: pair.to.label,
      fromPath: await materialize(pair.from),
      toPath: await materialize(pair.to),
    },
    { judge: new RulesJudge(), keepResidual: true, timeoutMs: 180_000 },
  );
  process.stdout.write(
    `${pair.api} ${pair.from.label} -> ${pair.to.label}: ${result.reached}, ` +
      `${result.places?.aligned ?? "?"} places, ${result.places?.decided ?? "?"} left after decisions` +
      `${result.decidedError ? ` (decided: ${result.decidedError})` : ""}\n`,
  );
  const seen = new Set<string>();
  for (const entry of result.residualDecided ?? []) {
    if (kind !== undefined && entry.id !== kind) continue;
    const place = placeOf(entry);
    if (seen.has(place)) continue;
    seen.add(place);
    const places = byKind.get(entry.id) ?? new Map<string, number>();
    places.set(place, (places.get(place) ?? 0) + 1);
    byKind.set(entry.id, places);
  }
}

for (const [id, places] of [...byKind].sort((a, b) => b[1].size - a[1].size)) {
  process.stdout.write(`\n## ${id}: ${places.size} places\n`);
  for (const place of [...places.keys()].slice(0, 8)) {
    process.stdout.write(`  ${place.split("\n").slice(1).join(" | ")}\n`);
  }
}
