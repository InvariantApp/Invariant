/**
 * The reduced path must agree with the full changelog about what is breaking.
 *
 * Checked against real pairs, because the reduced path only exists for
 * documents too large to check any other way, and agreement on a fixture says
 * nothing about agreement on Stripe.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract } from "@invariant/contract";
import { BREAKING_INFO_IDS, breakingEntries, diffOutcome } from "@invariant/diff";
import { materializePair, readManifest } from "./manifest.mts";

// Generated from the policy, so this check cannot pass because the file it
// wrote happened to match a stale copy of the policy.
const severity = join(tmpdir(), "invariant-agree-severity.txt");
await writeFile(
  severity,
  `${[...BREAKING_INFO_IDS].map((id) => `${id} warn`).join("\n")}\n`,
);

const pairs = (await readManifest()).pairs.filter((pair) => pair.source === "git");

const sample = pairs
  .filter((_, index) => index % 7 === 0)
  .slice(0, Number(process.argv[2] ?? 8));
let checked = 0;
let disagreed = 0;

for (const pair of sample) {
  try {
    const local = await materializePair(pair);
    const from = await loadContract(local.fromPath, "from");
    const to = await loadContract(local.toPath, "to");
    const full = await diffOutcome(from.document, to.document, { fallback: false });
    if (full.mode !== "changelog") continue;
    const reduced = await diffOutcome(from.document, to.document, {
      mode: "breaking",
      extraArgs: ["--severity-levels", severity],
      fallback: false,
    });

    const key = (entry: {
      id: string;
      operationId: string;
      path: string;
      text: string;
    }) => `${entry.id}|${entry.operationId}|${entry.path}|${entry.text}`;
    const a = new Set(breakingEntries(full.entries).map(key));
    const b = new Set(breakingEntries(reduced.entries).map(key));
    const onlyFull = [...a].filter((k) => !b.has(k));
    const onlyReduced = [...b].filter((k) => !a.has(k));
    checked += 1;
    if (onlyFull.length > 0 || onlyReduced.length > 0) {
      disagreed += 1;
      console.log(
        `DISAGREE ${pair.api} ${pair.from.label}: full-only ${onlyFull.length}, reduced-only ${onlyReduced.length}`,
      );
      for (const k of [...onlyFull.slice(0, 3), ...onlyReduced.slice(0, 3)])
        console.log("   ", k.slice(0, 130));
    } else {
      console.log(`agree    ${pair.api} ${pair.from.label} (${a.size} breaking)`);
    }
  } catch (error) {
    console.log(`skip     ${pair.api}: ${String(error).slice(0, 90)}`);
  }
}
console.log(`\n${checked} pairs compared, ${disagreed} disagreed`);
