/**
 * What a stranger gets: every package published to a private registry, then
 * installed into an empty project and used from nothing.
 *
 * Nothing from this repository reaches the project except through the
 * registry, and Go is taken off the PATH, so the gate has to find the oasdiff
 * binary the platform package installed. The steps are the ones the
 * quickstart gives:
 *
 *   npm install @invariant/cli        (from the registry)
 *   invariant init                    must end in a passing first check
 *   (a pull request breaks the API)
 *   invariant check                   must block, naming what broke
 *
 * Run after `pnpm build` and `scripts/fetch-oasdiff.mts --host`.
 *
 *   node --import tsx scripts/install-test.mts
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 4873 + Math.floor(Math.random() * 1000);
const REGISTRY = `http://127.0.0.1:${PORT}/`;
const WINDOWS = process.platform === "win32";
const started = Date.now();

function step(message: string): void {
  process.stdout.write(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}\n`);
}

/** Runs a command through the platform's shell, so npm and npx resolve on Windows too. */
async function sh(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: WINDOWS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (!options.allowFailure) {
      throw new Error(
        `${command} ${args.join(" ")} failed:\n${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      );
    }
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

const work = await mkdtemp(join(tmpdir(), "invariant-install-"));
let registry: ChildProcess | undefined;

try {
  // A registry that holds this project's packages and fetches everything else
  // from npm, as the public registry will once they are published there.
  const storage = join(work, "storage");
  await mkdir(storage, { recursive: true });
  await writeFile(
    join(work, "verdaccio.yaml"),
    [
      `storage: ${JSON.stringify(storage)}`,
      // The universal macOS oasdiff binary is larger than the default limit.
      "max_body_size: 100mb",
      "uplinks:",
      "  npmjs:",
      "    url: https://registry.npmjs.org/",
      "packages:",
      "  '@invariant/*':",
      "    access: $all",
      "    publish: $all",
      "  '**':",
      "    access: $all",
      "    proxy: npmjs",
      "log: { type: stdout, format: pretty, level: error }",
      "",
    ].join("\n"),
    "utf8",
  );
  registry = spawn(
    process.execPath,
    [
      join(ROOT, "node_modules/verdaccio/bin/verdaccio"),
      "--config",
      join(work, "verdaccio.yaml"),
      "--listen",
      `127.0.0.1:${PORT}`,
    ],
    { stdio: "ignore" },
  );
  for (let tries = 0; ; tries += 1) {
    const up = await fetch(`${REGISTRY}-/ping`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) break;
    if (tries > 120) throw new Error("the local registry did not start");
    await sleep(500);
  }
  step(`registry at ${REGISTRY}`);

  // Anonymous publishing is allowed by the registry's configuration, but the
  // npm client refuses to publish without some token for the host.
  const npmrc = join(work, ".npmrc");
  await writeFile(
    npmrc,
    `registry=${REGISTRY}\n//127.0.0.1:${PORT}/:_authToken=install-test\n`,
    "utf8",
  );

  const packages = (await readdir(join(ROOT, "packages"))).sort();
  let published = 0;
  for (const name of packages) {
    const manifest = JSON.parse(
      await readFile(join(ROOT, "packages", name, "package.json"), "utf8"),
    ) as { private?: boolean; name: string };
    if (manifest.private) continue;
    await sh(
      "pnpm",
      ["publish", "--registry", REGISTRY, "--no-git-checks", "--access", "public"],
      {
        cwd: join(ROOT, "packages", name),
        env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc },
      },
    );
    published += 1;
  }
  step(`published ${published} packages`);

  // An empty project somewhere this repository cannot be reached from, with
  // Go removed from the PATH so nothing can fall back to a local oasdiff.
  const project = join(work, "provider");
  await mkdir(join(project, "api"), { recursive: true });
  await cp(
    join(ROOT, "fixtures/provider-acme/openapi/head.json"),
    join(project, "api/openapi.json"),
  );
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "provider", private: true, type: "module" }),
    "utf8",
  );
  await sh("git", ["init", "-q"], { cwd: project });

  const path = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((entry) => !/[\\/]go[\\/]bin$|[\\/]go$/.test(entry))
    .join(delimiter);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: path,
    NPM_CONFIG_USERCONFIG: npmrc,
    NO_COLOR: "1",
  };
  delete env["OASDIFF_BIN"];

  await sh("npm", ["install", "--no-audit", "--no-fund", "@invariant/cli"], {
    cwd: project,
    env,
  });
  step("installed @invariant/cli from the registry");

  const first = await sh(
    "npx",
    ["invariant", "init", "--no-ci", "--label", "2026-09-01"],
    {
      cwd: project,
      env,
      allowFailure: true,
    },
  );
  if (first.code !== 0 || !first.stdout.includes("First check: PASS")) {
    throw new Error(
      `init did not end in a passing check:\n${first.stdout}${first.stderr}`,
    );
  }
  step("invariant init: first check passed");

  const document = JSON.parse(await readFile(join(project, "api/openapi.json"), "utf8"));
  delete document.components.schemas.Payment.properties.currency;
  document.components.schemas.Payment.required =
    document.components.schemas.Payment.required.filter(
      (name: string) => name !== "currency",
    );
  await writeFile(join(project, "api/openapi.json"), JSON.stringify(document), "utf8");

  const second = await sh("npx", ["invariant", "check"], {
    cwd: project,
    env,
    allowFailure: true,
  });
  if (
    second.code !== 1 ||
    !second.stdout.includes("Release status: BLOCK") ||
    !second.stdout.includes("currency")
  ) {
    throw new Error(
      `a breaking change was not blocked:\n${second.stdout}${second.stderr}`,
    );
  }
  step("invariant check: blocked the breaking change, naming it");

  process.stdout.write(
    `\nA stranger's install works, in ${((Date.now() - started) / 1000).toFixed(0)}s.\n`,
  );
} finally {
  registry?.kill();
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}
