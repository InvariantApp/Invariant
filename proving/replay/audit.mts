/**
 * Rig E, the check on the classes: how often the classifier agrees with a
 * careful reader, on a fixed sample.
 *
 * Every class a number rests on is model-judged, and a model's own
 * confidence is not evidence that it is right. So a sample is drawn the same
 * way every time (by the digest of each site's key, a few from each class),
 * read in full, and labelled in `audit.json` with the reader named. The
 * scoreboard publishes the agreement beside L8, per class; a class the reader
 * disagrees with often enough is not a denominator anyone should quote.
 *
 * Usage:
 *   node --import tsx proving/replay/audit.mts sample [--per-class 20]
 *     writes the sample, with each site's lines, to .cache/replay/audit-sample.md
 *   node --import tsx proving/replay/audit.mts score
 *     compares audit.json with classes.json
 *   node --env-file-if-exists=.env --import tsx proving/replay/audit.mts reclassify
 *     classes every cached site again, from its cached lines, as the replay would
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "../corpus/manifest.mts";
import {
  cachedSites,
  classify,
  readClasses,
  type Site,
  type SiteClass,
  siteKey,
  writeClasses,
} from "./classify.mts";

const AUDIT = join(ROOT, "proving/replay/audit.json");
const SAMPLE = join(ROOT, ".cache/replay/audit-sample.md");

export interface AuditFile {
  about: string;
  /** Who read the sample: a person, or the agent that built the rig. */
  reader: string;
  labels: Record<string, { label: Exclude<SiteClass, "contested">; note?: string }>;
}

export interface Agreement {
  labelled: number;
  agreed: number;
  /** Per class the classifier gave: how many of its sampled sites the reader agreed with. */
  byClass: Record<string, { labelled: number; agreed: number }>;
}

/** How often the classes agree with the reader's labels, over the sites both have. */
export function agreement(
  classes: Record<string, { class: SiteClass }>,
  audit: AuditFile,
): Agreement {
  const result: Agreement = { labelled: 0, agreed: 0, byClass: {} };
  for (const [key, { label }] of Object.entries(audit.labels)) {
    const given = classes[key]?.class;
    if (given === undefined) continue;
    const bucket = result.byClass[given] ?? { labelled: 0, agreed: 0 };
    result.byClass[given] = bucket;
    bucket.labelled += 1;
    result.labelled += 1;
    if (given === label) {
      bucket.agreed += 1;
      result.agreed += 1;
    }
  }
  return result;
}

const order = (key: string) => createHash("sha256").update(key).digest("hex");

/** The same sample every time: the first sites of each class by the digest of their keys. */
export function sample(
  sites: readonly Site[],
  classes: Record<string, { class: SiteClass; model: string }>,
  perClass: number,
): Site[] {
  const picked: Site[] = [];
  const byClass = new Map<string, Site[]>();
  for (const site of sites) {
    const record = classes[siteKey(site)];
    // A rule's class is the text's own; only judged ones are sampled.
    if (!record || record.model.startsWith("rule:")) continue;
    byClass.set(record.class, [...(byClass.get(record.class) ?? []), site]);
  }
  for (const [, group] of [...byClass].sort(([a], [b]) => a.localeCompare(b))) {
    picked.push(
      ...[...group]
        .sort((a, b) => order(siteKey(a)).localeCompare(order(siteKey(b))))
        .slice(0, perClass),
    );
  }
  return picked;
}

function render(site: Site): string {
  const { base, region } = site;
  const before = base.slice(Math.max(0, region.oldStart - 4), region.oldStart);
  const removed = base.slice(region.oldStart, region.oldEnd);
  const after = base.slice(region.oldEnd, region.oldEnd + 4);
  return [
    "```diff",
    ...before.map((line) => `  ${line}`),
    ...removed.map((line) => `- ${line}`),
    ...region.lines.map((line) => `+ ${line}`),
    ...after.map((line) => `  ${line}`),
    "```",
  ].join("\n");
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const option = (name: string) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const classes = readClasses();
  if (command === "sample") {
    const picked = sample(cachedSites(), classes, Number(option("per-class") ?? 20));
    const text = picked
      .map(
        (site) =>
          `## ${siteKey(site)}\n\n${site.package} ${site.from || "?"} -> ${site.to}, \`${site.file}\`; classed **${classes[siteKey(site)]?.class}**\n\n${render(site)}\n`,
      )
      .join("\n");
    await writeFile(SAMPLE, text);
    process.stdout.write(`${picked.length} sites written to ${SAMPLE}\n`);
    return;
  }
  if (command === "score") {
    if (!existsSync(AUDIT)) throw new Error("no audit.json yet");
    const audit = JSON.parse(readFileSync(AUDIT, "utf8")) as AuditFile;
    process.stdout.write(`${JSON.stringify(agreement(classes, audit), null, 2)}\n`);
    return;
  }
  if (command === "reclassify") {
    const { TypeSafeClient } = await import("@typesafe-ai/sdk");
    const { JEV_MODEL } = await import("@invariant-app/proposer");
    const client = new TypeSafeClient() as unknown as Parameters<typeof classify>[2];
    const sites = cachedSites();
    // A case's sites together, as the replay asks them, so each batch shares
    // what was upgraded.
    const byCase = new Map<string, Site[]>();
    for (const site of sites)
      byCase.set(site.caseId, [...(byCase.get(site.caseId) ?? []), site]);
    const fresh: typeof classes = {};
    for (const group of byCase.values()) {
      await classify(group, fresh, client, JEV_MODEL);
      await writeClasses({ ...classes, ...fresh });
    }
    process.stdout.write(`${Object.keys(fresh).length} sites classed again\n`);
    return;
  }
  throw new Error("usage: audit.mts sample | score | reclassify");
}

if (process.argv[1]?.endsWith("audit.mts")) await main();
