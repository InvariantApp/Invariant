import { analysePair } from "@invariant-app/eval";
import { RulesJudge } from "@invariant-app/proposer";
import { materialize, readManifest } from "./manifest.mts";
const m = await readManifest();
const pair = m.pairs.find((p) => p.api === process.argv[2] && p.to.label.includes(process.argv[3]!))!;
const r = await analysePair({ api: pair.api, fromVersion: pair.from.label, toVersion: pair.to.label, fromPath: await materialize(pair.from), toPath: await materialize(pair.to) }, { judge: new RulesJudge(), timeoutMs: 180000 });
console.log(r.reached, JSON.stringify(r.places), r.breakingAfterDecided, r.decidedError ?? "");
