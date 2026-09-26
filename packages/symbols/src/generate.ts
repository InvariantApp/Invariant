/**
 * The symbol map of one SDK release against the contract it speaks.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Contract,
  digestOf,
  type OpenApiDocument,
  stripNonWire,
} from "@invariant-app/contract";
import { isCurrent, type SymbolCache } from "./cache.ts";
import {
  detectGenerators,
  documentedCalls,
  stripeDeclaredCalls,
  stripeDirectoryNamespaces,
} from "./generators.ts";
import { RulesSymbolJudge, type SymbolJudge } from "./judge.ts";
import { matchTypes } from "./match.ts";
import { matchOperations } from "./operations.ts";
import { readGo } from "./read/go.ts";
import { readPython } from "./read/python.ts";
import { readTypeScript } from "./read/typescript.ts";
import { schemaShapes } from "./schemas.ts";
import {
  type CallSite,
  type Declaration,
  type GeneratedSymbols,
  type GeneratorId,
  type Language,
  SYMBOLS_ENGINE,
} from "./types.ts";

export interface SymbolInput {
  /**
   * The unpacked release: an npm package's directory, a `site-packages`
   * (or one package's own directory) holding the wheel, or a Go module's
   * root.
   */
  sdk: string;
  language: Language;
  /** The contract the release speaks, as a loaded contract or a bare document. */
  contract: Contract | OpenApiDocument;
  /** The package's name; read from the release where it records one. */
  package?: string;
  /** The package's version; read from the release where it records one. */
  version?: string;
  /** For Python, the top-level module to read when `sdk` holds several. */
  module?: string;
  /** Who decides ties. Rules by default, which never calls a model. */
  judge?: SymbolJudge;
  /** The least share of fields in common for a structural match; 0.8 by default. */
  threshold?: number;
}

/** What a release declares, before anything is matched. */
export interface Release {
  declarations: Declaration[];
  calls: CallSite[];
  generators: GeneratorId[];
}

/** Reads the declarations and HTTP calls of an unpacked release. */
export function readRelease(sdk: string, language: Language, module?: string): Release {
  const found = new Set(detectGenerators(sdk, language));
  let declarations: Declaration[];
  let calls: CallSite[];
  if (language === "typescript") {
    const release = readTypeScript(sdk);
    declarations = release.declarations;
    calls = release.calls;
    if (release.openapiTypescript) found.add("openapi-typescript");
    if (found.has("stripe")) {
      // Types inside `namespace Stripe` are reached through it, and so are
      // the resources declared beside them. It is the API objects that say
      // so: stripe-node from 22.1.1 declares a `Stripe.Decimal` beside
      // resources that sit in their directories.
      const namespaced = declarations.some(
        (each) =>
          each.qualified.startsWith("Stripe.") &&
          each.constants?.["object"] !== undefined,
      );
      if (!namespaced) stripeDirectoryNamespaces(declarations, calls);
      calls = [...stripeDeclaredCalls(sdk, namespaced ? "Stripe" : undefined), ...calls];
    }
  } else if (language === "python") {
    ({ declarations, calls } = readPython(sdk, module));
  } else {
    ({ declarations, calls } = readGo(sdk));
  }
  return {
    declarations,
    calls: [...documentedCalls(sdk, language, calls), ...calls],
    generators: [...found].sort(),
  };
}

function isContract(value: Contract | OpenApiDocument): value is Contract {
  return (
    typeof (value as Contract).digest === "string" &&
    typeof (value as Contract).document === "object"
  );
}

/** A contract's digest, and its document. */
export function contractParts(contract: Contract | OpenApiDocument): {
  digest: string;
  document: OpenApiDocument;
} {
  if (isContract(contract))
    return { digest: contract.digest, document: contract.document };
  return { digest: digestOf(stripNonWire(contract)), document: contract };
}

/** The name and version a release records about itself, where it does. */
export function identify(
  sdk: string,
  language: Language,
  module?: string,
): { package?: string; version?: string } {
  if (language === "typescript" && existsSync(join(sdk, "package.json"))) {
    const manifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    return {
      ...(manifest.name ? { package: manifest.name } : {}),
      ...(manifest.version ? { version: manifest.version } : {}),
    };
  }
  if (language === "python" && existsSync(sdk)) {
    for (const entry of readdirSync(sdk)) {
      if (!entry.endsWith(".dist-info")) continue;
      const metadata = join(sdk, entry, "METADATA");
      if (!existsSync(metadata)) continue;
      const text = readFileSync(metadata, "utf8");
      const name = /^Name:\s*(.+)$/m.exec(text)?.[1]?.trim();
      const version = /^Version:\s*(.+)$/m.exec(text)?.[1]?.trim();
      const top = existsSync(join(sdk, entry, "top_level.txt"))
        ? readFileSync(join(sdk, entry, "top_level.txt"), "utf8").split(/\s+/)
        : [];
      if (module && name && !top.includes(module) && name.replace(/-/g, "_") !== module) {
        continue;
      }
      return { ...(name ? { package: name } : {}), ...(version ? { version } : {}) };
    }
  }
  if (language === "go" && existsSync(join(sdk, "go.mod"))) {
    const path = /^module\s+(\S+)/m.exec(readFileSync(join(sdk, "go.mod"), "utf8"))?.[1];
    // The module proxy unpacks a module as `path@version`.
    const version = /@(v[^/]+)$/.exec(sdk)?.[1];
    return { ...(path ? { package: path } : {}), ...(version ? { version } : {}) };
  }
  return {};
}

/** Matches what a release declares against a contract. */
export async function matchRelease(
  release: Release,
  document: OpenApiDocument,
  options: { language: Language; judge?: SymbolJudge; threshold?: number },
): Promise<Pick<GeneratedSymbols, "types" | "operations" | "unmatched">> {
  const judge = options.judge ?? new RulesSymbolJudge();
  const shapes = schemaShapes(document, options.language);
  const { types, unmatched } = await matchTypes(shapes, release.declarations, {
    language: options.language,
    judge,
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
  });
  return { types, operations: matchOperations(document, release.calls), unmatched };
}

/**
 * The symbol map of an unpacked SDK release: which type implements each of
 * the contract's schemas and which method calls each operation, each entry
 * with how it was found and how sure that is.
 */
export async function generateSymbols(input: SymbolInput): Promise<GeneratedSymbols> {
  const judge = input.judge ?? new RulesSymbolJudge();
  const { digest, document } = contractParts(input.contract);
  const known = identify(input.sdk, input.language, input.module);
  const release = readRelease(input.sdk, input.language, input.module);
  const matched = await matchRelease(release, document, {
    language: input.language,
    judge,
    ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
  });
  return {
    formatVersion: 1,
    package: input.package ?? known.package ?? "",
    version: input.version ?? known.version ?? "",
    language: input.language,
    contract: digest,
    generators: release.generators,
    engine: SYMBOLS_ENGINE,
    judge: judge.fingerprint,
    ...matched,
  };
}

/**
 * The symbol map from `cache` when one there was made by this code and this
 * judge, and otherwise made now and kept. A release with no name or version
 * to key it by is never cached.
 */
export async function cachedSymbols(
  input: SymbolInput,
  cache: SymbolCache,
): Promise<GeneratedSymbols> {
  const judge = input.judge ?? new RulesSymbolJudge();
  const { digest } = contractParts(input.contract);
  const known = identify(input.sdk, input.language, input.module);
  const pkg = input.package ?? known.package;
  const version = input.version ?? known.version;
  const key = pkg && version ? { package: pkg, version, contract: digest } : undefined;
  if (key) {
    const cached = await cache.get(key);
    if (cached && isCurrent(cached, judge.fingerprint)) return cached;
  }
  const made = await generateSymbols({ ...input, judge });
  if (key) await cache.set(key, made);
  return made;
}
