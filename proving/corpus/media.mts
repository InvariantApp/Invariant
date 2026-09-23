/**
 * Media types real providers use for bodies, and which of them are read as
 * JSON.
 *
 * JSON is written under more names than one, and reading only the exact name
 * left whole APIs invisible: this is what the corpus actually contains.
 *
 *   node --import tsx proving/corpus/media.mts
 */
import { loadContract, operationsOf } from "@invariant-app/contract";
import { materialize, readManifest } from "./manifest.mts";

const manifest = await readManifest();
const seen = new Map<string, number>();
const apis = new Map<string, string>();
for (const pair of manifest.pairs) {
  if (apis.has(pair.api)) continue;
  apis.set(pair.api, pair.to.label);
  let document: Awaited<ReturnType<typeof loadContract>>["document"];
  try {
    document = (await loadContract(await materialize(pair.to), "x")).document;
  } catch {
    continue;
  }
  for (const operation of operationsOf(document)) {
    const holders = [
      (operation.operation as { requestBody?: { content?: Record<string, unknown> } })
        .requestBody,
      ...Object.values(
        (operation.operation as { responses?: Record<string, never> }).responses ?? {},
      ),
    ];
    for (const holder of holders) {
      const content = (holder as { content?: Record<string, unknown> } | undefined)
        ?.content;
      for (const type of Object.keys(content ?? {}))
        seen.set(type, (seen.get(type) ?? 0) + 1);
    }
  }
}
const json = /^application\/json$/;
const alsoJson = /^(\*\/\*|application\/(\*|[a-z0-9.+-]*\+json)|application\/json;)/;
let read = 0;
let missed = 0;
for (const [type, n] of seen) {
  if (json.test(type)) read += n;
  else if (alsoJson.test(type)) missed += n;
}
console.log(
  `bodies read as JSON today ${read}; JSON in all but the exact name ${missed}`,
);
for (const [type, n] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 14))
  console.log(
    `${String(n).padStart(6)}  ${type}${json.test(type) ? "  (read)" : alsoJson.test(type) ? "  (missed)" : ""}`,
  );
