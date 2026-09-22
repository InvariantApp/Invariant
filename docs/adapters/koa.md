# Koa

The runtime wraps Koa's request handler.

## Serve old contracts

```sh
npm install @invariant-app/runtime @invariant-app/runtime-node
invariant compile   # writes invariant/compiled/program.json
```

```ts
import { createServer } from "node:http";
import { createRuntime } from "@invariant-app/runtime";
import { adaptListener } from "@invariant-app/runtime-node";
import program from "./invariant/compiled/program.json" with { type: "json" };

const runtime = createRuntime({ program });
createServer(adaptListener(app.callback(), { runtime })).listen(3000);
```

How a request names its contract comes with the program, from `identity` in
`invariant.yaml`. A request on the current contract passes straight through.

## The kill switch

The runtime asks for flags on every request, synchronously, so the source
never makes a request wait. From the hosted service, polled in the background
and kept on disk so a switch flipped during an incident survives a restart:

```ts
import { createClient } from "@invariant-app/client";
import { remoteFlags } from "@invariant-app/flags";

const token = process.env.INVARIANT_TOKEN;
if (!token) throw new Error("INVARIANT_TOKEN is not set");
const client = createClient({ baseUrl: "https://invariant-cloud.fly.dev", token });
const flags = remoteFlags({ client, cachePath: "/var/lib/invariant/flags.json" });
const runtime = createRuntime({ program, flags: flags.read });
```

The token needs the `flags:read` scope. Without the service, `flagsFrom({ path: "flags.json" })`
reads the same switches from a file or an environment variable.

## Report usage

Which contracts callers still use is what says one can be retired. The
telemetry package counts by the hour, never records a body or a value, and
hashes each consumer's key before it leaves the process:

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { controlPlaneSink, createTelemetry, startHeartbeat } from "@invariant-app/telemetry";

// The program's own digest, so the dashboard shows which build each instance runs.
const programText = readFileSync("invariant/compiled/program.json", "utf8");
const digest = `sha256:${createHash("sha256").update(programText).digest("hex")}`;

const telemetry = createTelemetry({ sinks: [controlPlaneSink(client)] });
const runtime = createRuntime({
  program: JSON.parse(programText),
  flags: flags.read,
  onUsage: telemetry.onUsage,
  onOutcome: telemetry.onOutcome,
});
const stopBeating = startHeartbeat({
  client,
  describe: () => ({ runtime: { version: "1.0.0", binding: "node" }, program: { digest } }),
});
process.on("SIGTERM", async () => { stopBeating(); await telemetry.close(); });
```

The token needs the `ingest` scope. The heartbeat is what tells "nobody used
this contract" apart from "nothing was reporting".
