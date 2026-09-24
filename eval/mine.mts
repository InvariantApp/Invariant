/**
 * Mines alignment questions from the pinned corpus's real deltas, and turns
 * the labelled ones into a corpus file.
 *
 *   node --import tsx eval/mine.mts --questions
 *     Compares every pair in proving/corpus/manifest.json with the proposer's
 *     own `schemaDeltas` and writes every alignment question drafting would
 *     ask, once per provider, removed field and set of candidates, to
 *     .cache/eval/questions.json, beside the fields each schema kept.
 *
 *   node --import tsx eval/mine.mts --write
 *     Joins those questions with the labels in eval/mined/labels.json and
 *     writes eval/corpus/17-mined-real-deltas.yaml. A question labelled
 *     unsure is left out. The corpus file is never edited by hand: a label is
 *     changed in labels.json, with its reason, and the file written again.
 *
 * See packages/eval/src/mine.ts for why the labels are read rather than
 * mined.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadContract, schemasOf } from "@invariant-app/contract";
import {
  distinct,
  labelled,
  type MinedLabel,
  type MinedQuestion,
  mineQuestions,
  renderMined,
} from "@invariant-app/eval";
import { questionsFor, schemaDeltas } from "@invariant-app/proposer";
import { cachePath, ROOT, readManifest } from "../proving/corpus/manifest.mts";

const QUESTIONS = join(ROOT, ".cache/eval/questions.json");
const LABELS = join(ROOT, "eval/mined/labels.json");
const OUT = join(ROOT, "eval/corpus/17-mined-real-deltas.yaml");

const fieldsOf = (document: unknown, schema: string): string[] => {
  const found = schemasOf(document as never)[schema];
  const properties =
    typeof found === "object" && found !== null && !Array.isArray(found)
      ? (found as Record<string, unknown>)["properties"]
      : undefined;
  return typeof properties === "object" && properties !== null
    ? Object.keys(properties).sort()
    : [];
};

if (process.argv.includes("--write")) {
  const questions = JSON.parse(await readFile(QUESTIONS, "utf8")) as MinedQuestion[];
  const labels = JSON.parse(await readFile(LABELS, "utf8")) as MinedLabel[];
  const cases = labelled(questions, labels);
  await writeFile(OUT, renderMined(cases), "utf8");
  const unsure = labels.length - cases.length;
  process.stdout.write(
    `${cases.length} cases written from ${labels.length} labels (${unsure} left out as unsure)\n`,
  );
} else {
  const manifest = await readManifest();
  const byId = new Map<string, MinedQuestion>();
  let skipped = 0;
  for (const [index, pair] of manifest.pairs.entries()) {
    if (index % 100 === 0) {
      process.stderr.write(
        `${index} of ${manifest.pairs.length} pairs, ${byId.size} questions\n`,
      );
    }
    const fromPath = cachePath(pair.from);
    const toPath = cachePath(pair.to);
    if (!existsSync(fromPath) || !existsSync(toPath)) {
      skipped += 1;
      continue;
    }
    try {
      const from = await loadContract(fromPath, pair.from.label);
      const to = await loadContract(toPath, pair.to.label);
      const questions = schemaDeltas(from.document, to.document).flatMap((delta) =>
        questionsFor(delta),
      );
      const origin = {
        api: pair.api,
        provider: pair.provider,
        from: pair.from.label,
        to: pair.to.label,
        url: pair.to.url,
      };
      for (const mined of mineQuestions(questions, origin, (schema) => ({
        oldFields: fieldsOf(from.document, schema),
        newFields: fieldsOf(to.document, schema),
      }))) {
        if (!byId.has(mined.id)) byId.set(mined.id, mined);
      }
    } catch (error) {
      skipped += 1;
      process.stderr.write(
        `${pair.api} ${pair.from.label}..${pair.to.label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`,
      );
    }
  }
  await mkdir(join(ROOT, ".cache/eval"), { recursive: true });
  const questions = distinct([...byId.values()]);
  await writeFile(QUESTIONS, JSON.stringify(questions), "utf8");
  const perProvider = new Map<string, number>();
  for (const mined of questions) {
    perProvider.set(
      mined.origin.provider,
      (perProvider.get(mined.origin.provider) ?? 0) + 1,
    );
  }
  process.stdout.write(
    `${questions.length} distinct questions of ${byId.size}, ${skipped} pairs skipped\n` +
      `  by provider: ${[...perProvider].map(([name, count]) => `${name} ${count}`).join(", ")}\n`,
  );
}
