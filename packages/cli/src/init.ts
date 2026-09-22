/**
 * `invariant init`: the first thing a provider runs.
 *
 * Two error messages in this tool used to tell people to run it, and it did not
 * exist, so first contact ended at "Unknown command". Its job is to get a
 * repository from nothing to a gate that runs, without asking anything it can
 * work out for itself:
 *
 * - find the OpenAPI document, or run the generator that produces it
 * - snapshot it as the baseline, the contract every existing caller is on
 * - read the version header, if the document declares one, from the document
 * - write invariant.yaml, with comments, and a CI workflow
 *
 * What it cannot work out it says, precisely, rather than guessing. A wrong
 * spec or a wrong baseline would make every later answer wrong in a way nobody
 * would think to question.
 */
import { exec, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadContract, operationsOf, standaloneText } from "@invariant-app/contract";
import { actionRef, BRAND, isJsonObject, type JsonValue } from "@invariant-app/ir";

const run = promisify(execFile);
const runShell = promisify(exec);

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export interface InitOptions {
  /** The repository to set up. */
  root: string;
  /** The specification, when there is one file and the provider names it. */
  spec?: string;
  /** A command that writes the specification, for a code-first provider. */
  specCommand?: string;
  /** Where `specCommand` writes it. */
  specOut?: string;
  /** The API's name. Defaults to the document's title. */
  api?: string;
  /** The baseline contract's label. Defaults to today's date. */
  label?: string;
  /** The header a caller declares its contract in, when detection is wrong. */
  header?: string;
  /** Whether to write a GitHub Actions workflow. Defaults to yes. */
  ci?: "github" | "none";
  /** Replace an existing invariant.yaml. */
  force?: boolean;
  /** Today, for the default label. Injected by tests. */
  today?: string;
}

export interface InitResult {
  configPath: string;
  /** The specification, relative to the repository. */
  spec: string;
  label: string;
  api: string;
  /** The version header found in the document, if any. */
  header: string | undefined;
  wrote: string[];
  /** Things the provider should know, in the order they matter. */
  notes: string[];
}

/** Directories that never hold a provider's own specification. */
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "coverage",
  "invariant",
]);

const SPEC_FILE = /\.(json|ya?ml)$/i;
const MAX_DEPTH = 6;
const MAX_FILES = 20_000;

export interface FoundSpec {
  path: string;
  /** The `openapi` or `swagger` version the document declares. */
  version: string;
}

async function candidates(root: string): Promise<string[]> {
  // A git repository says which files are the provider's own, which excludes
  // generated and vendored copies without having to guess at them.
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return stdout
      .split("\n")
      .filter((file) => SPEC_FILE.test(file))
      .filter((file) => !file.split("/").some((part) => SKIP.has(part)))
      .slice(0, MAX_FILES);
  } catch {
    const found: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
      for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
        if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (SPEC_FILE.test(entry.name)) found.push(path);
      }
    };
    await walk("", 0);
    return found;
  }
}

/** Reads just enough of a file to see whether it is an API description. */
async function declaredVersion(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const match = /["']?(openapi|swagger)["']?\s*:\s*["']?(\d+\.\d+(?:\.\d+)?)/.exec(
      head,
    );
    return match ? `${match[1]} ${match[2]}` : undefined;
  } finally {
    await handle.close();
  }
}

/** Every OpenAPI or Swagger document in the repository. */
export async function findSpecs(root: string): Promise<FoundSpec[]> {
  const found: FoundSpec[] = [];
  for (const path of await candidates(root)) {
    const version = await declaredVersion(join(root, path)).catch(() => undefined);
    if (version) found.push({ path, version });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Frameworks that generate a specification from code, and how to ask for it.
 *
 * Detected only to say something useful when no document is committed. The
 * command itself is the provider's to write, because how an application is
 * started is not something a scan of its dependencies can know.
 */
const GENERATORS: { marker: RegExp; file: string; name: string; hint: string }[] = [
  {
    file: "package.json",
    marker: /"@nestjs\/swagger"/,
    name: "NestJS Swagger",
    hint: "write the document from SwaggerModule.createDocument in a small script",
  },
  {
    file: "package.json",
    marker: /"@fastify\/swagger"/,
    name: "@fastify/swagger",
    hint: "write app.swagger() to a file after app.ready()",
  },
  {
    file: "package.json",
    marker: /"(@hono\/zod-openapi|hono-openapi)"/,
    name: "Hono OpenAPI",
    hint: "write app.getOpenAPIDocument() to a file",
  },
  {
    file: "package.json",
    marker: /"swagger-jsdoc"/,
    name: "swagger-jsdoc",
    hint: "write swaggerJsdoc(options) to a file",
  },
  {
    file: "pyproject.toml",
    marker: /fastapi/i,
    name: "FastAPI",
    hint: 'python -c "import json; from app.main import app; print(json.dumps(app.openapi()))" > openapi.json',
  },
  {
    file: "requirements.txt",
    marker: /fastapi/i,
    name: "FastAPI",
    hint: 'python -c "import json; from app.main import app; print(json.dumps(app.openapi()))" > openapi.json',
  },
  {
    file: "requirements.txt",
    marker: /drf-spectacular/i,
    name: "drf-spectacular",
    hint: "python manage.py spectacular --file openapi.yaml",
  },
  {
    file: "go.mod",
    marker: /github\.com\/swaggo\/swag/,
    name: "swag",
    hint: "swag init --outputTypes json",
  },
  {
    file: "pom.xml",
    marker: /springdoc/,
    name: "springdoc",
    hint: "the springdoc-openapi-maven-plugin writes the document during the build",
  },
  {
    file: "build.gradle",
    marker: /springdoc/,
    name: "springdoc",
    hint: "the springdoc-openapi-gradle-plugin writes the document during the build",
  },
];

export async function detectGenerators(root: string): Promise<string[]> {
  const found = new Map<string, string>();
  for (const generator of GENERATORS) {
    const path = join(root, generator.file);
    if (!existsSync(path)) continue;
    const text = await readFile(path, "utf8");
    if (generator.marker.test(text)) found.set(generator.name, generator.hint);
  }
  return [...found].map(([name, hint]) => `${name}: ${hint}`);
}

/**
 * The header callers use to name a version, if the document declares one.
 *
 * Read from the document rather than guessed, and only accepted when it is a
 * header parameter whose name says it is a version. Stripe's `Stripe-Version`
 * and GitHub's `X-GitHub-Api-Version` are both found this way.
 */
export function versionHeader(document: Record<string, JsonValue>): string | undefined {
  const counts = new Map<string, number>();
  const note = (parameter: JsonValue | undefined): void => {
    if (!isJsonObject(parameter)) return;
    let resolved: JsonValue | undefined = parameter;
    const ref = parameter["$ref"];
    if (typeof ref === "string" && ref.startsWith("#/components/parameters/")) {
      const components = document["components"];
      const parameters = isJsonObject(components) ? components["parameters"] : undefined;
      resolved = isJsonObject(parameters)
        ? parameters[ref.slice("#/components/parameters/".length)]
        : undefined;
    }
    if (!isJsonObject(resolved) || resolved["in"] !== "header") return;
    const name = resolved["name"];
    if (typeof name !== "string" || !/version/i.test(name)) return;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };

  const paths = document["paths"];
  if (isJsonObject(paths)) {
    for (const item of Object.values(paths)) {
      if (!isJsonObject(item)) continue;
      for (const parameter of Array.isArray(item["parameters"])
        ? item["parameters"]
        : []) {
        note(parameter);
      }
    }
  }
  for (const { operation } of operationsOf(document)) {
    const list = operation["parameters"];
    for (const parameter of Array.isArray(list) ? list : []) note(parameter);
  }

  // The one declared most widely, which is the API-wide one rather than an
  // operation that happens to take a version of something else.
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "api"
  );
}

/** Picks the specification, or explains exactly why it cannot. */
async function chooseSpec(options: InitOptions): Promise<string> {
  if (options.specCommand) {
    if (!options.specOut) {
      throw new InitError("--spec-command needs --spec-out, naming the file it writes");
    }
    try {
      // Through the shell, as the provider would type it: generators are
      // usually run with a redirect or through a package script.
      await runShell(options.specCommand, { cwd: options.root });
    } catch (error) {
      throw new InitError(
        `${options.specCommand} failed, so there is no specification to start from.\n` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!existsSync(resolve(options.root, options.specOut))) {
      throw new InitError(
        `${options.specCommand} ran but wrote no ${options.specOut}. Check --spec-out.`,
      );
    }
    return options.specOut;
  }

  if (options.spec) {
    if (!existsSync(resolve(options.root, options.spec))) {
      throw new InitError(`There is no ${options.spec}.`);
    }
    return options.spec;
  }

  const found = await findSpecs(options.root);
  const openapi3 = found.filter((spec) => spec.version.startsWith("openapi 3"));

  if (openapi3.length === 1) return (openapi3[0] as FoundSpec).path;

  if (openapi3.length > 1) {
    throw new InitError(
      "This repository has more than one OpenAPI document, and which one describes " +
        "the API is not something to guess. Name it with --spec:\n" +
        openapi3.map((spec) => `  ${spec.path}  (${spec.version})`).join("\n"),
    );
  }

  // A Swagger 2.0 document is read as it is published and converted on every
  // load, so the provider keeps the file they already maintain.
  const swagger = found.filter((spec) => spec.version.startsWith("swagger"));
  if (swagger.length === 1) return (swagger[0] as FoundSpec).path;
  if (swagger.length > 1) {
    throw new InitError(
      "This repository has more than one Swagger 2.0 document, and which one describes " +
        "the API is not something to guess. Name it with --spec:\n" +
        swagger.map((spec) => `  ${spec.path}`).join("\n"),
    );
  }

  const generators = await detectGenerators(options.root);
  throw new InitError(
    [
      "No OpenAPI document was found in this repository.",
      "",
      generators.length > 0
        ? "It looks like the specification is generated from code. Tell init how to produce it:"
        : "Pass the file with --spec, or, if it is generated from code, tell init how to produce it:",
      "",
      "  invariant init --spec-command '<command>' --spec-out openapi.json",
      ...(generators.length > 0 ? ["", ...generators.map((hint) => `  ${hint}`)] : []),
    ].join("\n"),
  );
}

function configText(input: {
  api: string;
  spec: string;
  specCommand: string | undefined;
  label: string;
  baseline: string;
  header: string | undefined;
}): string {
  const quoted = JSON.stringify(input.label);
  const current = input.specCommand
    ? [
        "  # Generated from code on every check, so the gate reads what the code",
        "  # says now rather than what a committed file said when it was last",
        "  # regenerated.",
        "  current:",
        `    command: ${input.specCommand}`,
        `    out: ${input.spec}`,
      ]
    : ["  # The specification as it stands on this branch.", `  current: ${input.spec}`];

  const identity = input.header
    ? [
        "# How a request says which contract it expects. First match wins.",
        "identity:",
        `  - kind: header`,
        `    name: ${input.header}`,
        "  - kind: default",
        `    label: ${quoted}`,
      ]
    : [
        "# How a request says which contract it expects. First match wins. The",
        "# document declares no version header, so every caller is on the baseline",
        "# until one is added, for example:",
        "#   - kind: header",
        "#     name: api-version",
        "identity:",
        "  - kind: default",
        `    label: ${quoted}`,
      ];

  return [
    `# ${BRAND.name}: ${BRAND.docs}/quickstart.md`,
    `api: ${input.api}`,
    "",
    "spec:",
    ...current,
    "  # The contract this branch builds. Change it in the pull request that",
    "  # makes the next breaking change, so that release gets a name of its own.",
    `  currentLabel: ${quoted}`,
    "  # Every contract still served to existing callers. The baseline is what",
    "  # production serves today. Removing one is how you stop serving it.",
    "  released:",
    `    ${quoted}: ${input.baseline}`,
    "",
    ...identity,
    "",
    "# How strictly two judgements are enforced. An unexplained breaking change",
    "# and a failed verification always block.",
    "gate:",
    "  declaredLossy: warn",
    "  unmigratableWithActiveConsumers: block",
    "",
  ].join("\n");
}

function workflowText(): string {
  return [
    `name: ${BRAND.name}`,
    "",
    "on:",
    "  pull_request:",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v5",
    `      - uses: ${actionRef()}`,
    "",
  ].join("\n");
}

export async function init(options: InitOptions): Promise<InitResult> {
  const root = resolve(options.root);
  const configPath = join(root, "invariant.yaml");
  if (existsSync(configPath) && !options.force) {
    throw new InitError(
      "invariant.yaml already exists. Pass --force to replace it, which starts the " +
        "contract history again from today.",
    );
  }

  const spec = relative(root, resolve(root, await chooseSpec({ ...options, root })));
  const specPath = join(root, spec);

  // Loaded the way every check will load it, so a document the gate cannot
  // read is refused now, with the reason, rather than on the first pull request.
  // What is read from it is read from that same form, so a Swagger 2.0
  // document's parameters are found where OpenAPI 3 puts them.
  const contract = await loadContract(specPath, "baseline");
  const document = contract.document as Record<string, JsonValue>;

  const info = document["info"];
  const title =
    isJsonObject(info) && typeof info["title"] === "string" ? info["title"] : "";
  const api = options.api ?? slug(title || basename(root));
  const label = options.label ?? options.today ?? new Date().toISOString().slice(0, 10);
  const header = options.header ?? versionHeader(document);

  const extension = extname(spec).toLowerCase() === ".json" ? ".json" : ".yaml";
  const baseline = `invariant/contracts/${label}.openapi${extension}`;
  const wrote: string[] = [];

  await mkdir(join(root, "invariant", "contracts"), { recursive: true });
  await mkdir(join(root, "invariant", "changes"), { recursive: true });
  await writeFile(join(root, baseline), await standaloneText(specPath), "utf8");
  wrote.push(baseline);

  const keep = join(root, "invariant", "changes", ".gitkeep");
  if (!existsSync(keep)) {
    await writeFile(keep, "", "utf8");
    wrote.push("invariant/changes/.gitkeep");
  }

  await writeFile(
    configPath,
    configText({
      api,
      spec,
      specCommand: options.specCommand,
      label,
      baseline,
      header,
    }),
    "utf8",
  );
  wrote.push("invariant.yaml");

  const notes: string[] = [
    `The baseline is ${spec} as it is right now. It should describe what production ` +
      "serves today, because every existing caller is assumed to be on it.",
    ...(contract.convertedFrom
      ? [
          `${spec} is Swagger 2.0. It stays as you publish it, and every check reads it ` +
            `converted to OpenAPI 3.0 by ${contract.convertedFrom.by}.`,
        ]
      : []),
  ];

  if ((options.ci ?? "github") === "github") {
    const workflow = join(root, ".github", "workflows", "invariant.yml");
    if (existsSync(workflow)) {
      notes.push(".github/workflows/invariant.yml already exists and was left alone.");
    } else {
      await mkdir(dirname(workflow), { recursive: true });
      await writeFile(workflow, workflowText(), "utf8");
      wrote.push(".github/workflows/invariant.yml");
    }
  }

  notes.push(
    header
      ? `Callers name their contract in the ${header} header, which the document declares.`
      : "The document declares no version header, so every caller is served the baseline. " +
          "See identity in invariant.yaml.",
  );

  return { configPath, spec, label, api, header, wrote, notes };
}

export function renderInit(result: InitResult): string {
  return [
    `Set up ${result.api}, with ${result.label} as the contract every existing caller is on.`,
    "",
    "Wrote:",
    ...result.wrote.map((path) => `  ${path}`),
    "",
    ...result.notes.map((note) => `- ${note}`),
    "",
    "Next: commit these, then change the API in a pull request and run",
    `  ${BRAND.command} check`,
    "to see what it would break for the callers already using it.",
  ].join("\n");
}
