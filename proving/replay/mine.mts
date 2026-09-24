/**
 * Rig E, the miner: where humans migrated real code across an SDK's breaking
 * release.
 *
 * A bot opens a pull request that bumps an SDK's major version; when the
 * bump breaks the build, a human pushes the call-site fixes onto the same
 * pull request. Those fixes are the ground truth the migration engine is
 * replayed against. GitHub's code search sees only the default branch, so
 * the history is found through the pull requests instead: merged Dependabot
 * and Renovate bumps whose files include source code as well as manifests.
 *
 * Only an index is kept: the repository, the commits on either side, the
 * package and versions, the licence and the source files touched. Nobody's
 * code is copied here, and a repository without a permissive licence is left
 * out.
 *
 * Usage:
 *   GITHUB_TOKEN=... node --import tsx proving/replay/mine.mts [--months 24] [--limit 200]
 *     [--package stripe] [--ecosystem pypi] [--per-package 60] [--minutes 40]
 *     [--language javascript]
 *
 * `--language` searches only repositories GitHub says are written in it, and
 * caps each package's cases in that language alone: npm's bumps are mostly
 * TypeScript repositories', and JavaScript is counted apart.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT } from "../corpus/manifest.mts";
import { languageOf } from "./sites.mts";

export type Ecosystem = "npm" | "pypi" | "go";

interface Target {
  /** The name the bump titles use. */
  package: string;
  ecosystems: Ecosystem[];
  /** Search phrases; each is searched as an exact title phrase. */
  titles: string[];
  /**
   * Words a person's own migration pull request has in its title, per
   * ecosystem: "read Stripe fields that basil relocated". Such a pull request
   * names no versions, so what it upgraded is read from its manifests' diff,
   * and it is kept only where that crosses a major version.
   */
  searches?: Partial<Record<Ecosystem, string[]>>;
}

/** One search: a bot's exact title phrase, or words from a person's title. */
interface Query {
  text: string;
  human: boolean;
}

/** An SDK bumped the usual ways: by Dependabot, or by Renovate. */
const sdk = (name: string, ecosystem: Ecosystem): Target => ({
  package: name,
  ecosystems: [ecosystem],
  titles: [
    `Bump ${name} from`,
    ecosystem === "go" ? `update module ${name}` : `update dependency ${name} to`,
  ],
});

/** SDKs of the APIs the corpus measures, in the languages the engine supports. */
const TARGETS: Target[] = [
  {
    package: "stripe",
    ecosystems: ["npm", "pypi"],
    titles: ["Bump stripe from", "update dependency stripe to"],
    // Python's contract migrations are mostly made by people rather than on
    // a bot's bump: PostHog's "read Stripe fields that basil relocated" moved
    // the SDK across a major and every read of a field the API version moved.
    searches: {
      pypi: [
        "stripe basil",
        "stripe acacia",
        "stripe clover",
        "stripe dahlia",
        "stripe api version",
        "upgrade stripe",
        "update stripe",
        "stripe sdk",
      ],
      // The same people's pull requests in JavaScript and TypeScript.
      npm: [
        "stripe basil",
        "stripe clover",
        "stripe acacia",
        "stripe api version",
        "upgrade stripe",
      ],
    },
  },
  {
    package: "github.com/stripe/stripe-go",
    ecosystems: ["go"],
    titles: [
      "Bump github.com/stripe/stripe-go",
      "update module github.com/stripe/stripe-go",
    ],
    // Dependabot does not move a Go module across a major version, since the
    // version is part of its import path; Renovate does, and people do it by
    // hand, naming the SDK and the version it moves to.
    searches: { go: ["stripe-go", "stripe api version", "upgrade stripe"] },
  },
  {
    package: "twilio",
    ecosystems: ["npm", "pypi"],
    titles: ["Bump twilio from", "update dependency twilio to"],
  },
  {
    package: "plaid",
    ecosystems: ["npm"],
    titles: ["Bump plaid from", "update dependency plaid to"],
  },
  {
    package: "plaid-python",
    ecosystems: ["pypi"],
    titles: ["Bump plaid-python from", "update dependency plaid-python to"],
    // Each plaid-python major pins a new Plaid API version.
    searches: { pypi: ["upgrade plaid", "update plaid", "plaid api version"] },
  },
  {
    package: "@octokit/rest",
    ecosystems: ["npm"],
    titles: ["Bump @octokit/rest from", "update dependency @octokit/rest to"],
    searches: { npm: ["upgrade octokit", "octokit v20", "octokit v21"] },
  },
  // GitHub's API through Actions' own client, which wraps Octokit.
  sdk("@actions/github", "npm"),
  {
    package: "github.com/google/go-github",
    ecosystems: ["go"],
    titles: [
      "Bump github.com/google/go-github",
      "update module github.com/google/go-github",
    ],
  },
  {
    // The corpus measures OpenAI's API, and its SDKs' 1.0 made every caller
    // rewrite: the largest body of human migrations of any API here.
    package: "openai",
    ecosystems: ["npm", "pypi"],
    titles: ["Bump openai from", "update dependency openai to"],
    searches: {
      pypi: ["upgrade openai", "migrate openai", "openai v1", "openai sdk"],
      npm: ["openai v4", "upgrade openai", "migrate openai"],
    },
  },
  {
    package: "@slack/web-api",
    ecosystems: ["npm"],
    titles: ["Bump @slack/web-api from", "update dependency @slack/web-api to"],
  },
  {
    package: "slack-sdk",
    ecosystems: ["pypi"],
    titles: ["Bump slack-sdk from", "update dependency slack-sdk to"],
  },
  {
    package: "PyGithub",
    ecosystems: ["pypi"],
    titles: ["Bump pygithub from", "update dependency pygithub to"],
  },
  {
    package: "kubernetes",
    ecosystems: ["pypi"],
    titles: ["Bump kubernetes from", "update dependency kubernetes to"],
    // A Kubernetes release that removes an API group (batch/v1beta1's
    // CronJob) moves every client call to it.
    searches: { pypi: ["upgrade kubernetes", "kubernetes client", "v1beta1"] },
  },
  {
    package: "docker",
    ecosystems: ["pypi"],
    titles: ["Bump docker from", "update dependency docker to"],
  },
  {
    package: "@shopify/shopify-api",
    ecosystems: ["npm"],
    titles: [
      "Bump @shopify/shopify-api from",
      "update dependency @shopify/shopify-api to",
    ],
  },
  // The rest of the corpus's providers, each in whichever languages it ships.
  ...[
    "Adyen",
    "asana",
    "boxsdk",
    "datadog-api-client",
    "elasticsearch",
    "langfuse",
    "meilisearch",
    "mistralai",
    "okta",
    "pdpyras",
    "qdrant-client",
    "resend",
    "spotipy",
    "supabase",
    "xero-python",
    // Corpus providers whose Python SDKs were not searched at first:
    // Cloudflare's 3.0 and 4.0 regenerated the whole client from its spec.
    "cloudflare",
    "grafana-client",
    "paypal-server-sdk",
    "python-intercom",
  ].map((name) => sdk(name, "pypi")),
  ...[
    "@adyen/api-library",
    "asana",
    "box-node-sdk",
    "@datadog/datadog-api-client",
    "@elastic/elasticsearch",
    "langfuse",
    "meilisearch",
    "@mistralai/mistralai",
    "@okta/okta-sdk-nodejs",
    "@qdrant/js-client-rest",
    "resend",
    "@supabase/supabase-js",
    "xero-node",
    "intercom-client",
    "@pagerduty/pdjs",
  ].map((name) => sdk(name, "npm")),
  {
    // Each plaid-go major pins a new Plaid API version, as plaid-python's does.
    ...sdk("github.com/plaid/plaid-go", "go"),
    searches: { go: ["plaid-go", "upgrade plaid"] },
  },
  {
    ...sdk("github.com/twilio/twilio-go", "go"),
    searches: { go: ["twilio-go"] },
  },
  ...[
    "github.com/adyen/adyen-go-api-library",
    "github.com/DataDog/datadog-api-client-go",
    "code.gitea.io/sdk/gitea",
    "github.com/slack-go/slack",
    "github.com/elastic/go-elasticsearch",
    "github.com/okta/okta-sdk-golang",
    "github.com/meilisearch/meilisearch-go",
    "github.com/PagerDuty/go-pagerduty",
  ].map((name) => sdk(name, "go")),
];

/** Licences under which a repository's history may be indexed and replayed. */
const PERMISSIVE = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "MPL-2.0",
]);

const MANIFESTS: Record<Ecosystem, RegExp> = {
  npm: /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/,
  pypi: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|setup\.(py|cfg)|uv\.lock)$/,
  go: /(^|\/)(go\.mod|go\.sum)$/,
};

/** A repository's main language on GitHub, for each ecosystem's search. */
const LANGUAGE: Record<Ecosystem, string | undefined> = {
  // TypeScript and JavaScript repositories both bump npm packages.
  npm: undefined,
  pypi: "python",
  go: "go",
};

const SOURCES: Record<Ecosystem, RegExp> = {
  npm: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
  pypi: /\.py$/,
  go: /\.go$/,
};

export interface ReplayCase {
  id: string;
  repo: string;
  pr: number;
  /** The commit the bump was made on: what the engine migrates. */
  base: string;
  /** The pull request's last commit: what the humans made of it. */
  head: string;
  package: string;
  ecosystem: Ecosystem;
  from: string;
  to: string;
  license: string;
  mergedAt: string;
  /** Source files the humans changed. */
  files: string[];
}

export interface ReplayIndex {
  about: string;
  cases: ReplayCase[];
}

const INDEX = join(ROOT, "proving/replay/index.json");

/** The versions a bump title names, if it names them. */
export function parseBump(
  title: string,
  target: Pick<Target, "package">,
): { from: string; to: string } | undefined {
  const escaped = target.package.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const dependabot = new RegExp(
    `[Bb]ump ${escaped}(?:/v\\d+)? from v?([\\w.+-]+) to v?([\\w.+-]+)`,
    // Package names are written in whatever case the ecosystem uses: PyPI's
    // `PyGithub` appears as `pygithub` in Dependabot's titles.
    "i",
  ).exec(title);
  if (dependabot) return { from: dependabot[1] as string, to: dependabot[2] as string };
  // Renovate names only the target: "Update dependency stripe to v14".
  const renovate = new RegExp(
    `[Uu]pdate (?:dependency|module) ${escaped}(?:/v(\\d+))? to v?([\\w.+-]+)`,
    "i",
  ).exec(title);
  if (renovate) return { from: "", to: renovate[2] as string };
  return undefined;
}

/**
 * The versions of `name` a pull request's manifests moved between, read from
 * the diff GitHub shows for each: `-stripe==11.4.0` and `+stripe==12.0.0` in
 * a requirements file, a Poetry or uv lock's `version =` line under the
 * package's `name =`, a `package.json` entry, or a `go.mod` line.
 */
export function bumpInPatches(
  files: readonly { filename: string; patch?: string }[],
  name: string,
): { from: string; to: string } | undefined {
  const normal = (raw: string) => raw.toLowerCase().replace(/[-_.]+/g, "-");
  const target = normal(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let from: string | undefined;
  let to: string | undefined;
  for (const file of files) {
    if (
      !file.patch ||
      !Object.values(MANIFESTS).some((pattern) => pattern.test(file.filename))
    )
      continue;
    let current = "";
    for (const line of file.patch.split("\n")) {
      const sign = line[0];
      const text = line.slice(1);
      const named = /^\s*name\s*=\s*"([^"]+)"/.exec(text);
      if (named) {
        current = normal(named[1] as string);
        continue;
      }
      if (sign !== "-" && sign !== "+") continue;
      let version: string | undefined;
      const locked = /^\s*version\s*=\s*"v?(\d[^"]*)"/.exec(text);
      if (locked && current === target) version = locked[1];
      const requirement =
        /(?:^|["'\s,])([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*\(?\s*(?:===|==|~=|>=|\^|~)\s*v?(\d[\w.+-]*)/.exec(
          text,
        );
      if (!version && requirement && normal(requirement[1] as string) === target) {
        version = requirement[2];
      }
      const npm = new RegExp(`"${escaped}"\\s*:\\s*"[\\^~>=v]*(\\d[^"]*)"`).exec(text);
      if (!version && npm) version = npm[1];
      const go = new RegExp(
        `^\\s*(?:require\\s+)?${escaped}(?:/v\\d+)?\\s+v(\\d[^\\s]*)`,
      ).exec(text);
      if (!version && go) version = go[1];
      // `stripe>=5.4.*` reads as `5.4.`; the wildcard is not part of it.
      version = version?.replace(/\.+$/, "");
      if (!version) continue;
      if (sign === "-") from ??= version;
      else to ??= version;
    }
  }
  return from && to && from !== to ? { from, to } : undefined;
}

/** Whether a bump crosses a major version, where breaking changes live. */
export function isMajor(from: string, to: string): boolean {
  const major = (version: string) => {
    const [first, second] = version.split(".");
    // Before 1.0 the minor version is the breaking one.
    return first === "0" ? `0.${second ?? ""}` : (first ?? "");
  };
  // Renovate does not say where it came from; the target alone is kept, and
  // the base commit's manifest says the rest when the case is replayed.
  if (from === "") return /^v?\d+(\.0)*$/.test(to) || to.endsWith(".0.0");
  // Only forward: Yelp/paasta moved kubernetes from 24 back to 21, which is
  // a different major and no migration to a breaking release.
  const parts = (version: string) =>
    version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(from), parts(to)];
  const forward =
    (a[0] ?? 0) < (b[0] ?? 0) ||
    ((a[0] ?? 0) === (b[0] ?? 0) && (a[1] ?? 0) < (b[1] ?? 0));
  return forward && major(from) !== major(to);
}

export function classify(
  files: readonly string[],
  ecosystems: readonly Ecosystem[],
): { ecosystem: Ecosystem; sources: string[] } | undefined {
  for (const ecosystem of ecosystems) {
    if (!files.some((file) => MANIFESTS[ecosystem].test(file))) continue;
    const sources = files.filter(
      (file) =>
        SOURCES[ecosystem].test(file) && !/(^|\/)(vendor|node_modules|dist)\//.test(file),
    );
    return { ecosystem, sources };
  }
  return undefined;
}

const TOKEN = process.env["GITHUB_TOKEN"] ?? "";
/** Each request as it is made, to stderr, for seeing where a slow run spends its time. */
const VERBOSE = process.argv.includes("--verbose");

/**
 * The API said to come back later than this run is willing to wait. A
 * workflow's token allows about a thousand requests an hour, and sleeping
 * until the reset used to run the job into its timeout with nothing written.
 */
class RateLimited extends Error {}

/** A fallback for a request that failed, except a rate limit, which ends the run. */
const orElse =
  <T,>(fallback: T) =>
  (error: unknown): T => {
    if (error instanceof RateLimited) throw error;
    return fallback;
  };

async function github<T>(path: string, attempt = 0): Promise<T> {
  if (VERBOSE)
    process.stderr.write(`${new Date().toISOString()} ${path.slice(0, 160)}\n`);
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "invariant-proving",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      // A request that never answers once held a run for most of an hour
      // with nothing written; it is given up on and asked again.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (attempt >= 3) throw error;
    await sleep(2_000 * (attempt + 1));
    return github(path, attempt + 1);
  }
  if (response.status === 403 || response.status === 429) {
    // The search API's thirty a minute resets within the minute and is worth
    // waiting for; an hourly limit is not, and ends the run. A secondary
    // limit, for too many requests at once, leaves the hourly allowance
    // unspent and says how long to back off, or means about a minute; its
    // hourly reset used to be read as the wait, and ended a run with most of
    // the hour's requests unmade.
    const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
    const reset = exhausted
      ? Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000
      : 0;
    const retryAfter = Number(response.headers.get("retry-after") ?? 0) * 1000;
    // A refusal for any other reason, as a repository whose access GitHub
    // blocked, is that request's failure alone.
    if (
      !exhausted &&
      retryAfter === 0 &&
      response.status === 403 &&
      !/rate limit/i.test(await response.text())
    ) {
      throw new Error(`403 for ${path}`);
    }
    const wait = Math.max(
      reset - Date.now(),
      retryAfter,
      exhausted ? 5_000 : 60_000 * (attempt + 1),
    );
    if (wait > 180_000 || attempt >= 3)
      throw new RateLimited(`rate limited for ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    return github(path, attempt + 1);
  }
  if (response.status >= 500 && attempt < 3) {
    await sleep(2_000 * (attempt + 1));
    return github(path, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} for ${path}`);
  return (await response.json()) as T;
}

interface SearchItem {
  number: number;
  title: string;
  repository_url: string;
  pull_request?: { merged_at: string | null };
}

function months(count: number): { from: string; to: string }[] {
  const windows: { from: string; to: string }[] = [];
  const now = new Date();
  for (let back = 0; back < count; back += 1) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 0));
    windows.push({
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    });
  }
  return windows;
}

async function readIndex(): Promise<ReplayIndex> {
  try {
    return JSON.parse(await readFile(INDEX, "utf8")) as ReplayIndex;
  } catch {
    return {
      about:
        "Rig E. Merged pull requests where a bot bumped an SDK across a major version and humans edited source files on the same pull request. Only this index is kept; the code stays in its repositories.",
      cases: [],
    };
  }
}

async function mine(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const monthCount = Number(option("months") ?? 24);
  const limit = Number(option("limit") ?? 200);
  // No one package may fill the index: go-github alone has hundreds of bumps a
  // year, and left uncapped it crowded out every SDK in another language.
  const perPackage = Number(option("per-package") ?? 60);
  const only = option("package");
  const ecosystem = option("ecosystem") as Ecosystem | undefined;
  const onlyLanguage = option("language");
  // Stops in time to write what it found, whatever else happens; told to
  // stop, it stops at the next search the same way, rather than losing
  // everything it found since it started.
  let deadline = Date.now() + Number(option("minutes") ?? 40) * 60_000;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      deadline = 0;
    });
  }

  const index = await readIndex();
  const known = new Set(index.cases.map((entry) => entry.id));
  const licences = new Map<string, { license: string; fork: boolean }>();
  let added = 0;

  let stopped = "";
  try {
    search: for (const target of TARGETS.filter(
      (entry) =>
        (!only || entry.package === only) &&
        (!ecosystem || entry.ecosystems.includes(ecosystem)),
    ).map((entry) =>
      // `stripe` is a package on npm and on PyPI; asked for one ecosystem, a
      // bump is classed only into that one.
      ecosystem ? { ...entry, ecosystems: [ecosystem] } : entry,
    )) {
      // The cap is per package in each ecosystem: stripe-node's cases once
      // used up stripe-python's share, and Python had eight.
      let mine = index.cases.filter(
        (entry) =>
          entry.package === target.package &&
          target.ecosystems.includes(entry.ecosystem) &&
          (!onlyLanguage || languageOf(entry) === onlyLanguage),
      ).length;
      // Asked for one ecosystem, only repositories in its language are
      // searched: most `Bump stripe from` pull requests are stripe-node
      // bumps, and reading each one's files to find that out took the whole
      // hour's rate limit for eight Python cases.
      const language = onlyLanguage ?? (ecosystem ? LANGUAGE[ecosystem] : undefined);
      const search = (
        phrase: Query,
        window: { from: string; to: string },
        page: number,
      ) =>
        github<{ total_count: number; items: SearchItem[] }>(
          `/search/issues?per_page=100&page=${page}&q=${encodeURIComponent(
            `${phrase.human ? phrase.text : `"${phrase.text}"`} in:title is:pr is:merged created:${window.from}..${window.to}${language ? ` language:${language}` : ""}`,
          )}`,
        );
      const monthly = months(monthCount);
      const whole = {
        from: (monthly.at(-1) as { from: string }).from,
        to: (monthly[0] as { to: string }).to,
      };
      const queries: Query[] = [
        ...target.titles.map((text) => ({ text, human: false })),
        ...(target.searches?.[ecosystem ?? target.ecosystems[0] ?? "npm"] ?? []).map(
          (text) => ({ text, human: true }),
        ),
      ];
      phrases: for (const phrase of queries) {
        // One query over the whole range where it has no more results than
        // the search API pages through (a thousand), which for most SDKs in
        // one language it does; month by month where it has more. A month a
        // query at a time was the only way before, and ninety-six queries a
        // package at thirty a minute took most of an hour's run.
        const first = await search(phrase, whole, 1);
        await sleep(2_100);
        const windows = first.total_count <= 1_000 ? [whole] : monthly;
        for (const window of windows) {
          // A month is read three pages deep: "Bump docker from" also matches
          // every docker/* action's bump, a thousand a month of them.
          for (let page = 1; page <= (window === whole ? 10 : 3); page += 1) {
            if (added >= limit) break search;
            if (mine >= perPackage) break phrases;
            if (Date.now() > deadline) {
              stopped = "out of time";
              break search;
            }
            const found =
              window === whole && page === 1 ? first : await search(phrase, window, page);
            for (const item of found.items) {
              if (added >= limit) break;
              const repo = item.repository_url.replace(
                "https://api.github.com/repos/",
                "",
              );
              const id = `${repo}#${item.number}`;
              if (known.has(id)) continue;
              // A bot's title names the versions; a person's pull request
              // says what it upgraded in its manifests, read below.
              let bump = parseBump(item.title, target);
              if (bump && !isMajor(bump.from, bump.to)) continue;
              if (!bump && !phrase.human) continue;

              let owner = licences.get(repo);
              if (!owner) {
                const meta = await github<{
                  license: { spdx_id: string } | null;
                  fork: boolean;
                }>(`/repos/${repo}`).catch(orElse(undefined));
                owner = {
                  license: meta?.license?.spdx_id ?? "NOASSERTION",
                  fork: meta?.fork ?? true,
                };
                licences.set(repo, owner);
              }
              if (owner.fork || !PERMISSIVE.has(owner.license)) continue;

              const files = await github<{ filename: string; patch?: string }[]>(
                `/repos/${repo}/pulls/${item.number}/files?per_page=100`,
              ).catch(orElse([] as { filename: string; patch?: string }[]));
              const kind = classify(
                files.map((file) => file.filename),
                target.ecosystems,
              );
              if (!kind || kind.sources.length === 0 || kind.sources.length > 50)
                continue;
              bump ??= bumpInPatches(files, target.package);
              if (!bump || !isMajor(bump.from, bump.to)) continue;

              const pull = await github<{
                base: { sha: string };
                head: { sha: string };
                merged_at: string | null;
              }>(`/repos/${repo}/pulls/${item.number}`).catch(orElse(undefined));
              if (!pull?.merged_at) continue;

              index.cases.push({
                id,
                repo,
                pr: item.number,
                base: pull.base.sha,
                head: pull.head.sha,
                package: target.package,
                ecosystem: kind.ecosystem,
                from: bump.from,
                to: bump.to,
                license: owner.license,
                mergedAt: pull.merged_at,
                files: kind.sources,
              });
              known.add(id);
              added += 1;
              if (
                !onlyLanguage ||
                languageOf({ ecosystem: kind.ecosystem, files: kind.sources }) ===
                  onlyLanguage
              ) {
                mine += 1;
              }
              process.stdout.write(
                `${id} ${target.package} ${bump.from} -> ${bump.to} (${kind.sources.length} files)\n`,
              );
            }
            // The search API allows thirty requests a minute.
            if (!(window === whole && page === 1)) await sleep(2_100);
            if (found.items.length < 100) break;
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof RateLimited)) throw error;
    stopped = error.message;
  } finally {
    // Whatever was found is kept, so the next run starts from it.
    index.cases.sort((a, b) => a.id.localeCompare(b.id));
    await writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
  if (stopped) process.stdout.write(`stopped early: ${stopped}\n`);
  const byEcosystem = new Map<string, number>();
  for (const entry of index.cases) {
    byEcosystem.set(entry.ecosystem, (byEcosystem.get(entry.ecosystem) ?? 0) + 1);
  }
  process.stdout.write(
    `\n${added} cases added; ${index.cases.length} in the index (${[...byEcosystem]
      .map(([name, count]) => `${name} ${count}`)
      .join(", ")})\n`,
  );
}

if (process.argv[1]?.endsWith("mine.mts")) await mine();
