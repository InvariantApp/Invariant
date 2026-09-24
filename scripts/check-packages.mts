/**
 * Whether every published package is one a stranger could install and use.
 *
 * Three questions per package, each of which has been answered wrong here
 * before anyone asked it:
 * - Does its built output import only what its manifest declares? The Hono
 *   binding imported `hono` without declaring it, and worked in this
 *   repository only because the workspace root happened to have it.
 * - Does the manifest point at files that exist, with types a TypeScript
 *   consumer can resolve? (publint and arethetypeswrong.)
 * - Does the runtime still import nothing but exact decimal arithmetic, now
 *   that it is a bundle rather than a directory of sources?
 *
 * Run after `pnpm build`. Exits non-zero on the first package that fails.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { binaryFor, PLATFORM_BINARIES } from "@invariant-app/diff";
import { publint } from "publint";
import { formatMessage } from "publint/utils";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Imports each package may make at run time beyond its declared dependencies. */
const RUNTIME_ONLY = new Map([
  ["@invariant-app/runtime", new Set(["@invariant-app/decimal"])],
  ["@invariant-app/decimal", new Set<string>()],
]);

interface Manifest {
  name: string;
  private?: boolean;
  os?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function packageOf(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] as string;
}

async function importsOf(dir: string): Promise<Set<string>> {
  const found = new Set<string>();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(js|d\.ts)$/.test(entry.name)) continue;
    const text = await readFile(join(entry.parentPath, entry.name), "utf8");
    for (const match of text.matchAll(
      /(?:^|\s)(?:import|export)\s[^'"]*?from\s*["']([^"'./][^"']*)["']|import\s*\(\s*["']([^"'./][^"']*)["']\s*\)|^import\s+["']([^"'./][^"']*)["']/gm,
    )) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier) found.add(specifier);
    }
  }
  return found;
}

const failures: string[] = [];
const packages = (await readdir(join(ROOT, "packages"))).sort();

for (const name of packages) {
  const dir = join(ROOT, "packages", name);
  const manifest = JSON.parse(
    await readFile(join(dir, "package.json"), "utf8"),
  ) as Manifest;
  if (manifest.private) continue;

  // A platform package carries one upstream binary and no code of ours. What
  // matters is that the binary is there and is the one that was verified.
  if (manifest.os) {
    const binary = PLATFORM_BINARIES.find((entry) => entry.package === manifest.name);
    if (!binary) {
      failures.push(`${manifest.name} is not listed in packages/diff/src/binaries.ts`);
      continue;
    }
    // Every platform's binary is fetched for a release. An ordinary CI run
    // fetches only its own, so only that one is required there.
    const required = process.argv.includes("--all-binaries") || binary === binaryFor();
    if (!required) {
      process.stdout.write(`checked ${manifest.name} (binary not fetched here)\n`);
      continue;
    }
    for (const file of [
      join("bin", binary.executable),
      "LICENSE",
      "NOTICE",
      "sbom.cdx.json",
    ]) {
      if (!existsSync(join(dir, file))) {
        failures.push(
          `${manifest.name} has no ${file}. Run scripts/fetch-oasdiff.mts before packing.`,
        );
      }
    }
    process.stdout.write(`checked ${manifest.name}\n`);
    continue;
  }

  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ]);

  const imported = await importsOf(join(dir, "dist"));
  for (const specifier of imported) {
    if (builtins.has(specifier)) {
      if (RUNTIME_ONLY.has(manifest.name)) {
        failures.push(
          `${manifest.name} imports ${specifier}, and must import no built-ins`,
        );
      }
      continue;
    }
    const owner = packageOf(specifier);
    const allowed = RUNTIME_ONLY.get(manifest.name);
    if (allowed && !allowed.has(owner)) {
      failures.push(`${manifest.name} imports ${owner}, which the request path may not`);
    }
    if (!declared.has(owner)) {
      failures.push(`${manifest.name} imports ${owner} without declaring it`);
    }
  }

  const { messages, pkg } = await publint({ pkgDir: dir, strict: true, pack: "pnpm" });
  for (const message of messages) {
    if (message.type === "suggestion") continue;
    failures.push(`${manifest.name}: ${formatMessage(message, pkg)}`);
  }

  // Packed by pnpm, as a publish would be: npm ignores `publishConfig`, so a
  // tarball it made would describe a package nobody is ever sent.
  const packed = await mkdtemp(join(tmpdir(), "invariant-pack-"));
  try {
    const { stdout } = await run(
      "pnpm",
      ["pack", "--pack-destination", packed, "--json"],
      {
        cwd: dir,
      },
    );
    const tarball = (JSON.parse(stdout) as { filename: string }).filename;
    // Exports that are data rather than code, such as the control plane's
    // contract, have no types to find and are not what this checks.
    const exported = Object.keys(
      (manifest as { publishConfig?: { exports?: Record<string, unknown> } })
        .publishConfig?.exports ?? {},
    );
    const data = exported.filter((path) => /\.(ya?ml|json)$/.test(path));
    await run(
      "npx",
      [
        "attw",
        tarball,
        "--profile",
        "esm-only",
        "--format",
        "ascii",
        ...(data.length > 0 ? ["--exclude-entrypoints", ...data] : []),
      ],
      {
        cwd: ROOT,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (error) {
    const output = (error as { stdout?: string }).stdout ?? String(error);
    failures.push(`${manifest.name}: arethetypeswrong\n${output.trim()}`);
  } finally {
    await rm(packed, { recursive: true, force: true });
  }

  process.stdout.write(`checked ${manifest.name}\n`);
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("every published package is installable as declared\n");
}
