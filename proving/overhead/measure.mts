/**
 * What the proxy adds to a request, for launch gate L19.
 *
 *   node --import tsx proving/overhead/measure.mts [--rps 200] [--items 40] [--seconds 5] [--record] [--check]
 *
 * `--record` writes the measurement to `results.json`, which the scoreboard
 * reads. `--check` exits non-zero over budget, which is how CI asserts it: in
 * a step of its own, never beside other tests competing for the same CPU,
 * where a latency gate would fail for reasons that are not the proxy's.
 */
import { writeFile } from "node:fs/promises";
import { BUDGET, measureOverhead } from "./overhead.ts";

const option = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const result = await measureOverhead({
  rps: option("rps", BUDGET.rps),
  items: option("items", BUDGET.items),
  seconds: option("seconds", BUDGET.seconds),
});
console.log(JSON.stringify(result));
if (process.argv.includes("--record")) {
  await writeFile(
    new URL("./results.json", import.meta.url),
    `${JSON.stringify({ ...result, budget: BUDGET }, null, 2)}\n`,
  );
}
if (process.argv.includes("--check")) {
  const errors = result.direct.errors + result.current.errors + result.adapted.errors;
  if (errors > 0 || result.addedP99Ms > BUDGET.addedP99Ms) {
    console.error(
      `over budget: ${result.addedP99Ms} ms added at p99 (budget ${BUDGET.addedP99Ms}), ${errors} errors`,
    );
    process.exit(1);
  }
}
