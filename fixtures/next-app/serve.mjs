/**
 * A Next.js custom server with the runtime in front of it, for the adapter
 * suite (launch gate L10). Each Next.js version the suite runs is its own
 * package that passes its `next` in, so the version's own React and Next
 * resolve from its own directory.
 *
 * The routes live once, in this package's `app/`; they are copied into the
 * version's directory and built there, again only when they change.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createRuntime } from "@invariant/runtime";
import { adaptListener } from "@invariant/runtime-node";

const SOURCE = join(import.meta.dirname, "app");

function digestOf(dir) {
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort()) {
    hash.update(entry.slice(dir.length)).update(readFileSync(entry));
  }
  return hash.digest("hex");
}

/** Builds the app in `dir` with that version's Next.js, unless it is already built from these routes. */
export function build(dir) {
  const stamp = join(dir, ".next", "invariant-routes.sha256");
  const digest = digestOf(SOURCE);
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === digest) return;
  rmSync(join(dir, "app"), { recursive: true, force: true });
  cpSync(SOURCE, join(dir, "app"), { recursive: true });
  const built = spawnSync(join(dir, "node_modules", ".bin", "next"), ["build"], {
    cwd: dir,
    // To stderr: stdout is where the address is announced.
    stdio: ["ignore", 2, 2],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  if (built.status !== 0) throw new Error(`next build failed in ${dir}`);
  writeFileSync(stamp, digest);
}

/** Serves the built app on a free port and prints `listening <url>` once it can be called. */
export async function serve(next, dir, programPath) {
  build(dir);
  const app = next({ dev: false, dir, quiet: true });
  await app.prepare();
  const handle = app.getRequestHandler();
  const runtime = createRuntime({
    program: JSON.parse(readFileSync(programPath, "utf8")),
  });
  const server = createServer(
    adaptListener((request, response) => handle(request, response), { runtime }),
  );
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(`listening http://127.0.0.1:${server.address().port}\n`);
  });
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
