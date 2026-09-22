/**
 * The proxy for the overhead measurement, in its own process, with a program
 * that adapts every item of the list for an old contract.
 *
 *   node --import tsx proving/overhead/proxy.mts <upstream>
 */
import { createRuntime } from "@invariant-app/runtime";
import { createProxy } from "../../packages/sidecar/src/proxy.ts";
import { serve } from "../../packages/sidecar/src/server.ts";
import { PROGRAM } from "./program.ts";

const upstream = process.argv[2] as string;
const listening = await serve(
  createProxy({ runtime: createRuntime({ program: PROGRAM }), upstream }),
  { port: 0 },
);
process.stdout.write(`${listening.url}\n`);
