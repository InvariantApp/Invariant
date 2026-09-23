/**
 * What an SDK exports, and what changed between two of its releases.
 *
 * The helper reads each release's exported objects with their types, the
 * wire names their struct tags give fields, and the API operations their
 * documentation says each method calls. Comparing two releases says which
 * objects were renamed and nothing else, which can be rewritten exactly, and
 * which were removed or changed, which cannot.
 */
import { askHelper, type GoOptions, goCommand } from "./helper.ts";

/** One exported object of an SDK, as the helper names it. */
export interface SurfaceObject {
  /** The package's path inside the module, "" for the module's root. */
  package: string;
  /** `Repository`, `Repository.Name`, `ActionsService.DeleteEnvSecret`. */
  key: string;
  kind: "type" | "field" | "method" | "func" | "var" | "const";
  /** A type's underlying type, a function's signature without names, or a value's type. */
  type: string;
  signature?: string;
  /** A field's wire name. */
  json?: string;
  embedded?: boolean;
  /** API operations a method calls, as `GET /repos/{owner}/{repo}`. */
  operations?: string[];
  /** A function's parameter types, in order. */
  params?: string[];
  /**
   * What a call to the function becomes where the SDK marks it
   * `//go:fix inline`: another function of the same package, with the type
   * arguments the body instantiates it with, or the builtin `new`.
   */
  inline?: { to?: string; typeArgs?: string[]; builtin?: "new" };
  deprecated?: boolean;
}

/** An SDK object, named as the helper names it. */
export interface GoSymbol {
  package: string;
  key: string;
}

export const symbolId = (symbol: GoSymbol): string =>
  `${symbol.package}\u0000${symbol.key}`;

/**
 * Reads the exported surface of the packages `packages` of `module` at
 * `version`, downloading the module through the proxy.
 */
export async function readSurface(
  module: string,
  version: string,
  packages: readonly string[],
  options: GoOptions = {},
  /** A directory the go command may run in; any will do. */
  cwd = process.cwd(),
): Promise<SurfaceObject[]> {
  return surfaceIn(
    await downloadModule(module, version, options, cwd),
    module,
    packages,
    options,
  );
}

/** Where a module's source is once downloaded through the proxy. */
export async function downloadModule(
  module: string,
  version: string,
  options: GoOptions = {},
  cwd = process.cwd(),
): Promise<string> {
  const downloaded = JSON.parse(
    await goCommand(["mod", "download", "-json", `${module}@${version}`], cwd, options),
  ) as { Dir?: string; Error?: string };
  if (!downloaded.Dir) {
    throw new Error(
      `${module}@${version} could not be downloaded: ${downloaded.Error ?? ""}`,
    );
  }
  return downloaded.Dir;
}

/** Reads the exported surface of the module `module` whose source is at `dir`. */
export async function surfaceIn(
  dir: string,
  module: string,
  packages: readonly string[],
  options: GoOptions = {},
): Promise<SurfaceObject[]> {
  const response = await askHelper<{ objects: SurfaceObject[]; errors?: string[] }>(
    {
      command: "surface",
      dir,
      packages: packages.map((pkg) => (pkg === "" ? "." : `./${pkg}`)),
      targets: [module],
    },
    options,
  );
  if (response.objects.length === 0 && response.errors?.length) {
    throw new Error(`${module} could not be read: ${response.errors[0]}`);
  }
  return response.objects;
}

export interface SurfaceRename {
  from: GoSymbol;
  /** The new name of the object's last segment. */
  to: string;
  reason: string;
}

export interface SurfaceChange {
  symbol: GoSymbol;
  kind: SurfaceObject["kind"];
  /** Gone from the new release, with nothing that is exactly it under another name. */
  removed: boolean;
  before: SurfaceObject;
  after?: SurfaceObject;
}

/**
 * A method gone in favour of another on the same type that calls the same
 * API operations, with different parameters: not a rename, since a call has
 * to change more than its name, but what replaced it all the same.
 */
export interface SurfaceReplacement {
  from: GoSymbol;
  to: string;
  /** The parameters, by position, whose type the replacement changed or dropped. */
  params: number[];
  reason: string;
}

export interface SurfaceDiff {
  renames: SurfaceRename[];
  replacements: SurfaceReplacement[];
  changes: SurfaceChange[];
}

const holderOf = (key: string) => key.split(".").slice(0, -1).join(".");
const lastOf = (key: string) => key.split(".").at(-1) as string;

/**
 * The renames and changes from one release's surface to the next.
 *
 * A rename is claimed only where it is exact and unique: a type gone and one
 * added with the same underlying type, which no other type gone or added
 * shares; a field gone and one added on the same type with the same wire
 * name and type; a method gone and one added on the same type with the same
 * signature and the same API operations. go-github 90 renamed
 * `ActionsVariableCreateRequest` to `ActionsCreateVariableRequest` and
 * changed nothing else about it, which is such a rename. Anything less
 * certain is a change, and a change is shown to a person.
 */
export function diffSurfaces(
  before: readonly SurfaceObject[],
  after: readonly SurfaceObject[],
): SurfaceDiff {
  const id = (object: SurfaceObject) => symbolId(object);
  const old = new Map(before.map((object) => [id(object), object]));
  const next = new Map(after.map((object) => [id(object), object]));
  const gone = before.filter((object) => !next.has(id(object)));
  const added = after.filter((object) => !old.has(id(object)));
  const renames: SurfaceRename[] = [];
  const renamed = new Set<string>();

  const unique = (
    kind: SurfaceObject["kind"],
    sameAs: (a: SurfaceObject, b: SurfaceObject) => boolean,
    reason: (a: SurfaceObject, b: SurfaceObject) => string,
  ) => {
    const olds = gone.filter(
      (object) => object.kind === kind && !renamed.has(id(object)),
    );
    const news = added.filter((object) => object.kind === kind);
    for (const candidate of olds) {
      const matches = news.filter((each) => sameAs(candidate, each));
      if (matches.length !== 1) continue;
      const match = matches[0] as SurfaceObject;
      if (olds.filter((each) => sameAs(each, match)).length !== 1) continue;
      renames.push({
        from: { package: candidate.package, key: candidate.key },
        to: lastOf(match.key),
        reason: reason(candidate, match),
      });
      renamed.add(id(candidate));
    }
  };

  unique(
    "type",
    (a, b) => a.package === b.package && a.type === b.type,
    (a, b) => `${a.key} is now ${b.key}, with the same fields`,
  );
  // A renamed type's fields and methods are reached through its new name,
  // and are named the same on it.
  for (const rename of [...renames]) {
    const prefix = `${rename.from.key}.`;
    for (const member of gone) {
      if (member.package !== rename.from.package || !member.key.startsWith(prefix))
        continue;
      const moved = `${rename.to}.${member.key.slice(prefix.length)}`;
      if (next.has(symbolId({ package: member.package, key: moved }))) {
        renamed.add(id(member));
      }
    }
  }

  unique(
    "field",
    (a, b) =>
      a.package === b.package &&
      holderOf(a.key) === holderOf(b.key) &&
      a.json !== undefined &&
      a.json !== "-" &&
      a.json === b.json &&
      a.type === b.type &&
      !a.embedded &&
      !b.embedded,
    (a, b) => `${a.key} is now ${lastOf(b.key)}, still sent as "${a.json}"`,
  );
  unique(
    "method",
    (a, b) =>
      a.package === b.package &&
      holderOf(a.key) === holderOf(b.key) &&
      a.type === b.type &&
      (a.operations?.length ?? 0) > 0 &&
      (a.operations ?? []).join("\n") === (b.operations ?? []).join("\n"),
    (a, b) => `${a.key} is now ${lastOf(b.key)}, calling the same operation`,
  );

  // A signature that names a renamed type has not changed for that alone.
  const typeRenames = renames.filter((rename) => !rename.from.key.includes("."));
  const normalise = (text: string) =>
    typeRenames.reduce(
      (current, rename) =>
        current.replace(new RegExp(`\\b${lastOf(rename.from.key)}\\b`, "g"), rename.to),
      text,
    );
  const changes: SurfaceChange[] = [];
  for (const object of before) {
    if (renamed.has(id(object))) continue;
    const later = next.get(id(object));
    if (!later) {
      changes.push({
        symbol: { package: object.package, key: object.key },
        kind: object.kind,
        removed: true,
        before: object,
      });
      continue;
    }
    if (
      later.kind !== object.kind ||
      normalise(object.type) !== later.type ||
      (object.json ?? "") !== (later.json ?? "")
    ) {
      changes.push({
        symbol: { package: object.package, key: object.key },
        kind: object.kind,
        removed: false,
        before: object,
        after: later,
      });
    }
  }
  const replacements: SurfaceReplacement[] = [];
  for (const old of gone) {
    if (old.kind !== "method" || renamed.has(id(old)) || !old.operations?.length)
      continue;
    const calls = old.operations.join("\n");
    const successors = added.filter(
      (each) =>
        each.kind === "method" &&
        each.package === old.package &&
        holderOf(each.key) === holderOf(old.key) &&
        (each.operations ?? []).join("\n") === calls,
    );
    if (successors.length !== 1) continue;
    const successor = successors[0] as SurfaceObject;
    const after = successor.params ?? [];
    replacements.push({
      from: { package: old.package, key: old.key },
      to: lastOf(successor.key),
      params: (old.params ?? [])
        .map(normalise)
        .flatMap((type, index) => (type === after[index] ? [] : [index])),
      reason: `${old.key} is now ${lastOf(successor.key)}, which calls the same operation and takes ${successor.signature ?? successor.type}`,
    });
  }
  return { renames, replacements, changes };
}
