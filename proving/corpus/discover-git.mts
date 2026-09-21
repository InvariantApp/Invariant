/**
 * Collects successive published states of real APIs from the repositories the
 * providers publish them in.
 *
 * APIs.guru was the first source and it has a hard ceiling: of 2529 APIs only
 * 13 providers carry more than one version, and Azure is four fifths of those.
 * A corpus built from it is a corpus about Azure.
 *
 * The providers worth testing against publish their OpenAPI document in a git
 * repository and commit to it every time the API moves. Each commit that
 * touches the file is a state the API was really in, and consecutive commits
 * are a real step between two of them. That is a closer match to what this
 * system sees than a version bump is, because it is the same API evolving in
 * place rather than a new major version appearing beside the old one.
 *
 * What it finds is added to the pinned manifest, each file by a URL at the
 * exact commit and its full sha256. Pairs already in the manifest are left as
 * they are, so running this grows the corpus and never silently replaces what
 * earlier numbers were measured on. The specifications themselves are cached
 * under `.cache/` and never committed.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST, type ManifestPair, readManifest } from "./manifest.mts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CACHE = join(ROOT, ".cache/real-git");

const TOKEN = process.env["GITHUB_TOKEN"] ?? "";
/** How many successive states of one document to take. */
const DEPTH = Number(process.env["REAL_GIT_DEPTH"] ?? 8);

interface Source {
  provider: string;
  repo: string;
  /** A single path, or a prefix plus a pattern when the repo holds many. */
  path?: string;
  dir?: string;
  match?: RegExp;
  /** How many documents to take when the repo holds many. */
  files?: number;
  branch: string;
}

/**
 * Chosen for being the APIs people actually integrate against, and for
 * publishing a document that stands on its own. Repositories that split the
 * specification across relative `$ref`s are left out, not because they do not
 * matter but because fetching one file would give a document with holes in it,
 * and the failure would be a fact about the fetcher.
 */
const SOURCES: Source[] = [
  {
    provider: "stripe.com",
    repo: "stripe/openapi",
    path: "openapi/spec3.json",
    branch: "master",
  },
  {
    provider: "github.com",
    repo: "github/rest-api-description",
    path: "descriptions/api.github.com/api.github.com.json",
    branch: "main",
  },
  { provider: "box.com", repo: "box/box-openapi", path: "openapi.json", branch: "main" },
  {
    provider: "openai.com",
    repo: "openai/openai-openapi",
    path: "openapi.yaml",
    branch: "master",
  },
  {
    provider: "plaid.com",
    repo: "plaid/plaid-openapi",
    path: "2020-09-14.yml",
    branch: "master",
  },
  {
    provider: "intercom.com",
    repo: "intercom/Intercom-OpenAPI",
    dir: "descriptions",
    match: /^descriptions\/[^/]+\/api\.intercom\.io\.yaml$/,
    files: 6,
    branch: "main",
  },
  {
    provider: "twilio.com",
    repo: "twilio/twilio-oai",
    dir: "spec/json",
    match: /^spec\/json\/twilio_[^/]+\.json$/,
    files: 40,
    branch: "main",
  },
  {
    provider: "adyen.com",
    repo: "Adyen/adyen-openapi",
    dir: "json",
    match: /^json\/[^/]+\.json$/,
    files: 40,
    branch: "main",
  },
];

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      "user-agent": "invariant-eval",
      accept: "application/vnd.github+json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`${response.status} for ${path}`);
  return (await response.json()) as T;
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function filesIn(source: Source): Promise<string[]> {
  if (source.path) return [source.path];
  const tree = await api<{ tree: { path: string; size?: number }[] }>(
    `repos/${source.repo}/git/trees/${source.branch}?recursive=1`,
  );
  return (
    tree.tree
      .filter((entry) => source.match?.test(entry.path))
      // Largest first: the big documents are the interesting ones, and the ones
      // most likely to find a limit worth knowing about.
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
      .slice(0, source.files ?? 10)
      .map((entry) => entry.path)
  );
}

interface Commit {
  sha: string;
  commit: { committer: { date: string } };
}

const manifest = await readManifest();
const known = new Set(
  manifest.pairs.map((pair) => `${pair.from.sha256}:${pair.to.sha256}`),
);
const added: ManifestPair[] = [];
await mkdir(CACHE, { recursive: true });

for (const source of SOURCES) {
  let paths: string[];
  try {
    paths = await filesIn(source);
  } catch (error) {
    console.log(`  ${source.provider}: could not list (${String(error)})`);
    continue;
  }
  console.log(`${source.provider}: ${paths.length} document(s)`);

  for (const path of paths) {
    let commits: Commit[];
    try {
      commits = await api<Commit[]>(
        `repos/${source.repo}/commits?path=${encodeURIComponent(path)}&per_page=${DEPTH}`,
      );
    } catch {
      continue;
    }
    if (commits.length < 2) continue;

    // Oldest first, so a pair reads as a step forward in time.
    const ordered = [...commits].reverse();
    const slug = `${source.repo}/${path}`.replace(/[^a-zA-Z0-9]+/g, "-");
    const extension = path.endsWith(".json") ? "json" : "yaml";

    const states: { label: string; url: string; digest: string }[] = [];
    for (const commit of ordered) {
      const short = commit.sha.slice(0, 7);
      const date = commit.commit.committer.date.slice(0, 10);
      const file = join(CACHE, `${slug}-${date}-${short}.${extension}`);
      const url = `https://raw.githubusercontent.com/${source.repo}/${commit.sha}/${path}`;
      try {
        if (!existsSync(file)) {
          const response = await fetch(url, {
            headers: { "user-agent": "invariant-eval" },
          });
          if (!response.ok) continue;
          await writeFile(file, Buffer.from(await response.arrayBuffer()));
        }
        const digest = digestOf(await readFile(file));
        // A commit that touched the file without changing it is not a step.
        if (states.at(-1)?.digest === digest) continue;
        states.push({ label: `${date} ${short}`, url, digest });
      } catch {}
    }

    // Named by where the document sits under the source's directory, not by
    // its file name alone: Intercom publishes every API version as
    // descriptions/<version>/api.intercom.io.yaml, and naming them all
    // api.intercom.io made different pairs indistinguishable.
    const name = (
      source.dir
        ? path.slice(source.dir.length).replace(/^\//, "")
        : (path.split("/").pop() ?? path)
    ).replace(/\.(json|ya?ml)$/, "");
    for (let index = 0; index < states.length - 1; index += 1) {
      const from = states[index] as (typeof states)[number];
      const to = states[index + 1] as (typeof states)[number];
      const format = extension === "json" ? "json" : "yaml";
      if (known.has(`${from.digest}:${to.digest}`)) continue;
      known.add(`${from.digest}:${to.digest}`);
      added.push({
        api: `${source.provider}:${name}`,
        title: `${source.provider} ${name}`,
        provider: source.provider,
        source: "git",
        from: { label: from.label, url: from.url, sha256: from.digest, format },
        to: { label: to.label, url: to.url, sha256: to.digest, format },
      });
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
}

manifest.pairs.push(...added);
await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const byProvider = new Map<string, number>();
for (const pair of added) {
  byProvider.set(pair.provider, (byProvider.get(pair.provider) ?? 0) + 1);
}
console.log(
  `\n${added.length} new pairs added; the manifest now has ${manifest.pairs.length}`,
);
for (const [provider, count] of [...byProvider].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${provider}: ${count}`);
}
