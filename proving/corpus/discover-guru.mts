/**
 * Collects consecutive published versions of real APIs.
 *
 * Source is the APIs.guru directory, which is the only place that keeps more
 * than one version of the same specification, and more than one version is the
 * whole requirement: a single document says nothing about evolution.
 *
 * Two filters that matter. Only OpenAPI 3.x on both sides, because that is what
 * this supports and a Swagger 2.0 failure would be a finding about the fetcher
 * rather than about the compiler. And a cap per provider, because Azure alone
 * publishes more pairs than everybody else combined, and a result that is four
 * fifths one vendor's house style is a result about that house style.
 *
 * Specifications are cached under `.cache/` and never committed. They are
 * megabytes each and they belong to the people who wrote them. What gets
 * committed is the index below, with a digest per file, so a later run can say
 * whether it is looking at the same bytes.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST, type ManifestPair, readManifest } from "./manifest.mts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CACHE = join(ROOT, ".cache/real-specs");

/** Azure would otherwise be four fifths of the corpus. */
const PER_PROVIDER = Number(process.env["REAL_PER_PROVIDER"] ?? 25);

interface GuruVersion {
  swaggerUrl: string;
  openapiVer?: string;
  info?: { title?: string };
}
interface GuruApi {
  versions: Record<string, GuruVersion>;
}

function order(version: string): [number, string | number] {
  const numeric = Number(version);
  return Number.isNaN(numeric) ? [1, version] : [0, numeric];
}

function compare(a: string, b: string): number {
  const [ka, va] = order(a);
  const [kb, vb] = order(b);
  if (ka !== kb) return ka - kb;
  return va < vb ? -1 : va > vb ? 1 : 0;
}

async function download(url: string, to: string): Promise<string> {
  if (!existsSync(to)) {
    const response = await fetch(url, { headers: { "user-agent": "invariant-eval" } });
    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    await writeFile(to, Buffer.from(await response.arrayBuffer()));
  }
  return createHash("sha256")
    .update(await readFile(to))
    .digest("hex");
}

const limit = Number(process.argv[2] ?? 60);

await mkdir(CACHE, { recursive: true });
console.log("reading the APIs.guru directory");
const directory = (await (
  await fetch("https://api.apis.guru/v2/list.json", {
    headers: { "user-agent": "invariant-eval" },
  })
).json()) as Record<string, GuruApi>;

const candidates: {
  api: string;
  title: string;
  from: string;
  to: string;
  urls: [string, string];
}[] = [];
for (const [api, entry] of Object.entries(directory)) {
  const versions = entry.versions ?? {};
  const names = Object.keys(versions).sort(compare);
  for (let index = 0; index < names.length - 1; index += 1) {
    const from = names[index] as string;
    const to = names[index + 1] as string;
    const a = versions[from] as GuruVersion;
    const b = versions[to] as GuruVersion;
    if (!a.openapiVer?.startsWith("3") || !b.openapiVer?.startsWith("3")) continue;
    candidates.push({
      api,
      title: b.info?.title ?? api,
      from,
      to,
      urls: [a.swaggerUrl, b.swaggerUrl],
    });
  }
}

const perProvider = new Map<string, number>();
const chosen = candidates.filter((candidate) => {
  const provider = candidate.api.split(":")[0] as string;
  const seen = perProvider.get(provider) ?? 0;
  if (seen >= PER_PROVIDER) return false;
  perProvider.set(provider, seen + 1);
  return true;
});

console.log(
  `${candidates.length} OpenAPI 3.x pairs available, ${chosen.length} after capping ` +
    `at ${PER_PROVIDER} per provider, taking ${Math.min(limit, chosen.length)}`,
);

const manifest = await readManifest();
const known = new Set(
  manifest.pairs.map((pair) => `${pair.from.sha256}:${pair.to.sha256}`),
);
const added: ManifestPair[] = [];
for (const candidate of chosen.slice(0, limit)) {
  const slug = candidate.api.replace(/[^a-zA-Z0-9]+/g, "-");
  const fromFile = join(CACHE, `${slug}-${candidate.from}.json`);
  const toFile = join(CACHE, `${slug}-${candidate.to}.json`);
  try {
    const fromDigest = await download(candidate.urls[0], fromFile);
    const toDigest = await download(candidate.urls[1], toFile);
    if (known.has(`${fromDigest}:${toDigest}`)) continue;
    known.add(`${fromDigest}:${toDigest}`);
    added.push({
      api: candidate.api,
      title: candidate.title,
      provider: candidate.api.split(":")[0] as string,
      source: "apis.guru",
      from: {
        label: candidate.from,
        url: candidate.urls[0],
        sha256: fromDigest,
        format: "json",
      },
      to: {
        label: candidate.to,
        url: candidate.urls[1],
        sha256: toDigest,
        format: "json",
      },
    });
    process.stdout.write(".");
  } catch {
    // A specification that cannot be downloaded is not a finding about this
    // system, so it is skipped rather than recorded as a failure.
    process.stdout.write("x");
  }
}

manifest.pairs.push(...added);
await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`, "utf8");
console.log(
  `\n${added.length} new pairs added; the manifest now has ${manifest.pairs.length}`,
);
