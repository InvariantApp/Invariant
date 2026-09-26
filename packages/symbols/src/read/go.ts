/**
 * The structs a Go module declares, with the wire name each field's `json`
 * tag gives it, and the HTTP call each method makes.
 *
 * gofmt makes generated Go regular: a struct's fields sit one tab in, and
 * its closing brace at the margin. The Go pack's helper reads the same
 * facts through `go/types` when it can run; this reads them from source so
 * a map can be made where no Go toolchain is.
 */
import type { CallSite, Declaration } from "../types.ts";
import { filesUnder, textOf } from "./files.ts";

export interface GoRelease {
  declarations: Declaration[];
  calls: CallSite[];
}

/** A package path inside the module, "" for its root. */
const packageOf = (file: string): string => file.split("/").slice(0, -1).join("/");

const qualify = (pkg: string, name: string): string =>
  pkg === "" ? name : `${pkg}.${name}`;

/** Blanks comments and the text of string literals, keeping offsets and struct tags. */
function code(text: string): string {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

function structsIn(text: string, file: string, out: Declaration[]): void {
  const pkg = packageOf(file);
  const clean = code(text);
  for (const match of clean.matchAll(
    /^type\s+([A-Z]\w*)(?:\[[^\]]*\])?\s+struct\s*\{/gm,
  )) {
    const name = match[1] as string;
    const start = (match.index ?? 0) + match[0].length;
    const end = clean.indexOf("\n}", start);
    if (end < 0) continue;
    const tagged: string[] = [];
    const untagged: string[] = [];
    let anyTag = false;
    let depth = 0;
    for (const line of clean.slice(start, end).split("\n")) {
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      if (depth === 0) {
        const tag = /`[^`]*\bjson:"([^",]*)[^"]*"[^`]*`/.exec(line);
        const field = /^\s+([A-Za-z_]\w*)\s+\S/.exec(line);
        if (tag) anyTag = true;
        if (tag && tag[1] !== "-" && tag[1] !== "") tagged.push(tag[1] as string);
        else if (field && /^[A-Z]/.test(field[1] as string) && !tag) {
          untagged.push(field[1] as string);
        }
      }
      depth += opens - closes;
    }
    // An untagged exported field goes on the wire under its own name, unless
    // the struct tags the others: then it is the generator's own, as
    // openapi-generator's `AdditionalProperties`, which its marshaller spreads.
    const fields = anyTag ? tagged : untagged;
    out.push({
      qualified: qualify(pkg, name),
      name,
      kind: "object",
      fields,
      package: pkg,
      file,
    });
  }
  for (const match of clean.matchAll(
    /^type\s+([A-Z]\w*)(?:\[[^\]]*\])?\s+(=\s*)?(?!struct\b|interface\b)[\w.*[\]]+/gm,
  )) {
    const name = match[1] as string;
    out.push({ qualified: qualify(pkg, name), name, kind: "alias", package: pkg, file });
  }
}

const VERB =
  /(?:\bhttp\.Method(Get|Post|Put|Patch|Delete)\b|"(GET|POST|PUT|PATCH|DELETE)")/g;
const PATH = /"(\/?[A-Za-z0-9_\-.~{}%]*\/[A-Za-z0-9_\-.~{}%/:]*)"/g;

function callsIn(
  text: string,
  file: string,
  out: CallSite[],
  methods: Set<string>,
): void {
  const pkg = packageOf(file);
  const clean = code(text);
  for (const match of clean.matchAll(
    /^func\s+\(\s*\w*\s*\*?\s*([A-Z]\w*|[a-z]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Z]\w*)\s*\(/gm,
  )) {
    methods.add(`${pkg}\u0000${match[1]}.${match[2]}`);
    const start = match.index ?? 0;
    const end = clean.indexOf("\n}", start);
    const body = text.slice(start, end < 0 ? undefined : end);
    const verbs = [...body.matchAll(VERB)].map((each) => ({
      at: each.index ?? 0,
      verb: ((each[1] ?? each[2]) as string).toLowerCase(),
    }));
    if (verbs.length === 0) continue;
    for (const literal of body.matchAll(PATH)) {
      const at = literal.index ?? 0;
      let best: { at: number; verb: string } | undefined;
      for (const verb of verbs) {
        if (!best || Math.abs(verb.at - at) < Math.abs(best.at - at)) best = verb;
      }
      if (!best || Math.abs(best.at - at) > 600) continue;
      out.push({
        type: match[1] as string,
        method: match[2] as string,
        verb: best.verb,
        path: literal[1] as string,
        package: pkg,
        file,
      });
    }
  }
}

/** Reads the module unpacked at `root`: every exported type and every HTTP call. */
export function readGo(root: string): GoRelease {
  const declarations: Declaration[] = [];
  const calls: CallSite[] = [];
  const methods = new Set<string>();
  for (const file of filesUnder(
    root,
    (name) => name.endsWith(".go") && !name.endsWith("_test.go"),
  )) {
    const text = textOf(root, file);
    if (text === undefined) continue;
    structsIn(text, file, declarations);
    callsIn(text, file, calls, methods);
  }
  // openapi-generator's Go builds a request with `DeleteIdentity` and sends
  // it with `DeleteIdentityExecute`, which holds the call; a consumer names
  // the first.
  for (const call of [...calls]) {
    if (!call.method.endsWith("Execute") || call.method === "Execute") continue;
    const method = call.method.slice(0, -"Execute".length);
    if (!methods.has(`${call.package ?? ""}\u0000${call.type}.${method}`)) continue;
    calls.push({ ...call, method, through: `${call.type}.${call.method}` });
  }
  return { declarations, calls };
}
