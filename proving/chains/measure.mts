/**
 * What a long chain costs: compile time, program size, load time and the time
 * to transform one response, for launch gate L18.
 *
 *   node --import tsx proving/chains/measure.mts [--steps 50] [--operations 600] [--schemas 400] [--record]
 *
 * `--record` writes the Stripe-sized measurement to `results.json`, which the
 * scoreboard reads.
 */
import { writeFile } from "node:fs/promises";
import { BUDGET, measureChain } from "./cost.ts";
import { STRIPE_SIZED } from "./synthetic.ts";

const option = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const shape = {
  steps: option("steps", STRIPE_SIZED.steps),
  operations: option("operations", STRIPE_SIZED.operations),
  schemas: option("schemas", STRIPE_SIZED.schemas),
};

const cost = measureChain(shape);
console.log(JSON.stringify(cost));

if (process.argv.includes("--record")) {
  await writeFile(
    new URL("./results.json", import.meta.url),
    `${JSON.stringify({ ...cost, budget: BUDGET }, null, 2)}\n`,
  );
}
