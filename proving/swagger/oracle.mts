/**
 * A second opinion on every Swagger 2.0 document the corpus holds.
 *
 * Each 2.0 document is read through `@scalar/openapi-upgrader` on every load,
 * and everything downstream (the diff, the Changes, the program) is about the
 * converted document rather than the one the provider published. A mistake in
 * the conversion would be a mistake in everything, and invisible, because both
 * sides of a pair go through the same converter and agree with each other.
 *
 * So each document is also converted by `swagger2openapi`, an independent
 * implementation, and the two results are compared by the same differ the
 * gate uses. Where they disagree, one of them is wrong about the provider's
 * API, and which one is decided by reading the 2.0 source; each disagreement
 * settled in the converter's disfavour becomes a regression test in
 * `packages/contract`.
 *
 *   node --import tsx proving/swagger/oracle.mts [--provider a,b]
 *
 * Writes `proving/swagger/REPORT.md`. Large documents are left to CI, where
 * the differ has the memory they need; `--provider` narrows a local run.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ContractError,
  isSwagger2,
  normalizeDocument,
  type OpenApiDocument,
  readDocument,
  upgradeSwagger,
} from "@invariant-app/contract";
import { type DiffEntry, diffDocuments } from "@invariant-app/diff";
import swagger2openapi from "swagger2openapi";
import {
  type ManifestFile,
  materialize,
  ROOT,
  readManifest,
} from "../corpus/manifest.mts";

const REPORT = join(ROOT, "proving/swagger/REPORT.md");

const only = (() => {
  const index = process.argv.indexOf("--provider");
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined ? undefined : new Set(value.split(","));
})();

interface Checked {
  provider: string;
  label: string;
  sha256: string;
  entries: DiffEntry[];
  /** Why each settled entry is not a mistake of ours, by fingerprint. */
  reasons: Map<string, string>;
  /** Why the loader refuses the document itself, which is the right answer for an invalid one. */
  refused?: string;
  error?: string;
}

/** The independent conversion, with its fixes for invalid input switched on as ours are. */
async function secondOpinion(document: OpenApiDocument): Promise<OpenApiDocument> {
  const result = await swagger2openapi.convertObj(structuredClone(document), {
    patch: true,
    warnOnly: true,
    resolveInternal: false,
  });
  return result.openapi as OpenApiDocument;
}

/**
 * Differences read against the 2.0 source and found to be the second
 * converter's mistake, with why. Reported apart from the open ones, so a
 * difference nobody has looked at can never hide among ones that were.
 */
const EXAMPLE_AS_MEDIA_TYPE =
  "swagger2openapi turns a response's `examples` key into a media type. In 2.0 an " +
  "example names the media type it illustrates; only `produces` says what is produced.";

/** Whether the source's response has an example for a media type it does not produce. */
function exampleOnly(source: OpenApiDocument, entry: DiffEntry): boolean {
  const match = /media type `([^`]+)` for the response with the status `([^`]+)`/.exec(
    entry.text,
  );
  if (!match) return false;
  const [, type, status] = match as unknown as [string, string, string];
  const paths = source["paths"] as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const operation = paths[entry.path]?.[entry.operation.toLowerCase()];
  const response = (
    operation?.["responses"] as Record<string, Record<string, unknown>>
  )?.[status];
  const examples = response?.["examples"] as Record<string, unknown> | undefined;
  const produces = (operation?.["produces"] ?? source["produces"] ?? []) as string[];
  return examples?.[type] !== undefined && !produces.includes(type);
}

const SETTLED: Record<
  string,
  (source: OpenApiDocument, entry: DiffEntry) => string | undefined
> = {
  "response-body-media-type-schema-removed": (source, entry) =>
    exampleOnly(source, entry) ? EXAMPLE_AS_MEDIA_TYPE : undefined,
  "response-media-type-added": (source, entry) =>
    exampleOnly(source, entry) ? EXAMPLE_AS_MEDIA_TYPE : undefined,
};

function settled(source: OpenApiDocument, entry: DiffEntry): string | undefined {
  return SETTLED[entry.id]?.(source, entry);
}

/** Findings about the documents' metadata rather than about the conversion. */
const IGNORED = new Set(["api-version-not-bumped"]);

const manifest = await readManifest();
// Each document once, however many pairs it is a half of.
const documents = new Map<string, { provider: string; file: ManifestFile }>();
for (const pair of manifest.pairs) {
  if (only && !only.has(pair.provider)) continue;
  for (const file of [pair.from, pair.to]) {
    if (!documents.has(file.sha256))
      documents.set(file.sha256, { provider: pair.provider, file });
  }
}

const checked: Checked[] = [];
for (const { provider, file } of documents.values()) {
  let document: OpenApiDocument;
  try {
    document = await readDocument(await materialize(file));
  } catch {
    continue;
  }
  if (!isSwagger2(document)) continue;
  const row: Checked = {
    provider,
    label: file.label,
    sha256: file.sha256,
    entries: [],
    reasons: new Map(),
  };
  try {
    normalizeDocument(document);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    row.refused = error.message;
    checked.push(row);
    process.stdout.write(
      `${provider} ${file.label}: refused, ${error.message.slice(0, 80)}\n`,
    );
    continue;
  }
  try {
    const ours = upgradeSwagger(document);
    const theirs = await secondOpinion(document);
    // Every level, not only what breaks: a converter that quietly drops an
    // optional field is as wrong as one that drops a required one.
    row.entries = (await diffDocuments(ours, theirs, { mode: "changelog" })).filter(
      (entry) => !IGNORED.has(entry.id),
    );
    for (const entry of row.entries) {
      const reason = settled(document, entry);
      if (reason !== undefined) row.reasons.set(entry.fingerprint, reason);
    }
  } catch (error) {
    row.error =
      error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
  }
  checked.push(row);
  process.stdout.write(
    `${provider} ${file.label}: ${row.error ?? `${row.entries.length} differences`}\n`,
  );
}

const byId = new Map<
  string,
  { count: number; documents: Set<string>; sample: string; reason: string }
>();
for (const row of checked) {
  for (const entry of row.entries) {
    const reason = row.reasons.get(entry.fingerprint) ?? "open";
    const key = `${entry.id}\u0000${reason}`;
    const group = byId.get(key) ?? {
      count: 0,
      documents: new Set(),
      sample: "",
      reason,
    };
    group.count += 1;
    group.documents.add(`${row.provider} ${row.label}`);
    if (group.sample === "")
      group.sample = `${entry.operation} ${entry.path}: ${entry.text}`.trim();
    byId.set(key, group);
  }
}

const compared = checked.filter((row) => row.refused === undefined);
const openIn = (row: Checked) =>
  row.entries.filter((entry) => !row.reasons.has(entry.fingerprint)).length;
const agreeing = compared.filter((row) => !row.error && openIn(row) === 0).length;
const refused = checked.filter((row) => row.refused !== undefined);
const lines = [
  "# Swagger 2.0: two converters, one differ",
  "",
  "Generated by `proving/swagger/oracle.mts`. Each Swagger 2.0 document in the corpus",
  "converted by the upgrader every load uses and by `swagger2openapi`, and the two",
  "results compared by the differ the gate uses. A difference means the two",
  "converters disagree about the provider's API, and one of them is wrong.",
  "",
  `${checked.length} documents; ${agreeing} with no open difference; ` +
    `${compared.filter((row) => row.error).length} could not be compared; ` +
    `${refused.length} refused by the loader as invalid, with the reason.`,
  "",
  "| Provider | Document | Open | Settled |",
  "|---|---|---|---|",
  ...checked.map((row) =>
    row.refused
      ? `| ${row.provider} | ${row.label} | refused: ${row.refused.slice(0, 120).replaceAll("|", "\\|")} | |`
      : row.error
        ? `| ${row.provider} | ${row.label} | not compared: ${row.error} | |`
        : `| ${row.provider} | ${row.label} | ${openIn(row)} | ${row.entries.length - openIn(row)} |`,
  ),
  "",
  "## Differences by kind",
  "",
  ...(byId.size === 0
    ? ["None."]
    : [
        "| Finding | Count | Documents | Example | Settled |",
        "|---|---|---|---|---|",
        ...[...byId]
          .sort((a, b) => b[1].count - a[1].count)
          .map(
            ([key, group]) =>
              `| \`${key.split("\u0000")[0]}\` | ${group.count} | ${group.documents.size} | ${group.sample.replaceAll("|", "\\|").slice(0, 160)} | ${group.reason} |`,
          ),
      ]),
  "",
];
await writeFile(REPORT, lines.join("\n"), "utf8");
console.log(
  `\n${checked.length} documents, ${agreeing} with no open difference, ${refused.length} refused. Written to ${REPORT}`,
);
// A difference nobody has settled is a converter mistake until shown otherwise.
if (agreeing !== compared.length) process.exitCode = 1;
