/**
 * The description an XML body carries to the runtime.
 *
 * A program's instructions name fields; XML writes them as elements or
 * attributes, a list inside a wrapper or repeated in place, each named as the
 * schema's OpenAPI `xml` object says. The runtime cannot know any of that
 * from the instructions, so every body a site has work for, where the
 * operation declares it as XML, carries a description of the places the
 * instructions reach: read from the contract the body arrives in, written as
 * the contract it leaves for does.
 *
 * Only places an instruction reaches are described, and the elements on the
 * way to them. Everything else in the body is kept exactly as it came. A
 * place is found where it was in the body as it arrived, by undoing earlier
 * moves, and where it ends up, by following later ones, so a chain of
 * releases is described as one.
 *
 * What the runtime could not read back exactly is a compile issue, and the
 * release gate blocks on it: a map, which XML has no form for; a schema that
 * contains itself, which no finite description reaches the bottom of; a value
 * an instruction reads whose schema says nothing of what it is; a body that
 * is a value rather than an object. Amazon's CloudFront and CloudSearch are
 * the real cases; neither needs any of these.
 */
import {
  type OpenApiDocument,
  operationsOf,
  requestXmlSchema,
  resolveRef,
  resolveSchema,
  responseXmlSchemas,
} from "@invariant-app/contract";
import {
  type Instr,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parsePointer,
  type SiteProgram,
  siteKey,
  type XmlBody,
  type XmlNode,
  type XmlProgram,
} from "@invariant-app/ir";
import { isNcName } from "@invariant-app/runtime";
import type { ProjectionIssue } from "./project.ts";

/** One instruction as it runs: the places it touches from the body's root, and any move. */
interface Step {
  c: string;
  touched: string[][];
  /** Places whose value it reads, which have to be typed. */
  reads: string[][];
  move?: { from: string[]; to: string[] };
  /** A block of a schema that contains itself, or sits in too many places. */
  shared?: string;
}

/** Marks a chain's link blocks, as `chain.ts` names them. */
const LINK = ">";

/** The instructions as they run, every block written out where it is entered. */
function stepsOf(
  instrs: readonly Instr[],
  blocks: Readonly<Record<string, Instr[]>>,
  prefix: string[] = [],
  entered: ReadonlySet<string> = new Set(),
): Step[] {
  const at = (pointer: string) => [...prefix, ...parsePointer(pointer)];
  const out: Step[] = [];
  for (const instr of instrs) {
    switch (instr.k) {
      case "move":
        out.push({
          c: instr.c,
          touched: [at(instr.from), at(instr.to)],
          reads: [],
          move: { from: at(instr.from), to: at(instr.to) },
        });
        break;
      case "within":
        out.push({ c: instr.c, touched: [at(instr.path)], reads: [] });
        out.push(...stepsOf(instr.block, blocks, at(instr.path), entered));
        break;
      case "switch":
        out.push({ c: instr.c, touched: [at(instr.path)], reads: [at(instr.path)] });
        for (const block of Object.values(instr.cases)) {
          out.push(...stepsOf(block, blocks, prefix, entered));
        }
        break;
      case "has":
        out.push({ c: instr.c, touched: [at(instr.path)], reads: [] });
        out.push(...stepsOf(instr.block, blocks, prefix, entered));
        break;
      case "is":
        out.push({ c: instr.c, touched: [at(instr.path)], reads: [at(instr.path)] });
        out.push(...stepsOf(instr.block, blocks, prefix, entered));
        break;
      case "call":
        if (!instr.block.includes(LINK)) {
          out.push({ c: instr.c, touched: [], reads: [], shared: instr.block });
          break;
        }
        if (entered.has(instr.block)) break;
        out.push(
          ...stepsOf(
            blocks[instr.block] ?? [],
            blocks,
            prefix,
            new Set(entered).add(instr.block),
          ),
        );
        break;
      case "wrap":
      case "set":
      case "del":
        out.push({ c: instr.c, touched: [at(instr.path)], reads: [] });
        break;
      default:
        out.push({ c: instr.c, touched: [at(instr.path)], reads: [at(instr.path)] });
    }
  }
  return out;
}

/**
 * A request envelope's steps as they reach its body: every place under
 * `/@body`, from the body's root. A value moved between a parameter and the
 * body is a place written, or read, in the body alone.
 */
function inBody(steps: readonly Step[]): Step[] {
  const body = (path: readonly string[]) =>
    path[0] === "@body" ? [path.slice(1)] : ([] as string[][]);
  return steps.map((step) => {
    const out: Step = {
      c: step.c,
      touched: step.touched.flatMap(body),
      reads: step.reads.flatMap(body),
    };
    if (step.shared !== undefined) out.shared = step.shared;
    const from = step.move ? body(step.move.from)[0] : undefined;
    const to = step.move ? body(step.move.to)[0] : undefined;
    if (from !== undefined && to !== undefined) out.move = { from, to };
    return out;
  });
}

const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

/** Where a place read at a later step was in the body as it arrived. */
function traceBack(path: string[], earlier: readonly Step[]): string[] {
  let segments = path;
  for (const step of [...earlier].reverse()) {
    if (step.move && startsWith(segments, step.move.to)) {
      segments = [...step.move.from, ...segments.slice(step.move.to.length)];
    }
  }
  return segments;
}

/** Where a place written at an earlier step ends up in the body as it leaves. */
function traceForward(path: string[], later: readonly Step[]): string[] {
  let segments = path;
  for (const step of later) {
    if (step.move && startsWith(segments, step.move.from)) {
      segments = [...step.move.to, ...segments.slice(step.move.from.length)];
    }
  }
  return segments;
}

interface XmlInfo {
  name?: string;
  namespace?: string;
  prefix?: string;
  attribute?: boolean;
  wrapped?: boolean;
}

/**
 * A schema's `xml` object, the one nearest the place winning field by field:
 * written beside a reference, as CloudFront writes an item's name in an
 * `allOf` with the reference, over the referenced schema's own.
 */
function xmlOf(document: OpenApiDocument, schema: JsonValue, depth = 0): XmlInfo {
  if (!isJsonObject(schema) || depth > 32) return {};
  let found: XmlInfo = {};
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const target = resolveRef(document, ref);
    if (target !== undefined) found = xmlOf(document, target, depth + 1);
  }
  const members = Array.isArray(schema["allOf"]) ? schema["allOf"] : [];
  // A reference is the schema's own; anything written in place beside it says
  // how it is written here.
  for (const member of members.filter((each) => isJsonObject(each) && "$ref" in each)) {
    found = { ...found, ...xmlOf(document, member, depth + 1) };
  }
  for (const member of members.filter(
    (each) => !(isJsonObject(each) && "$ref" in each),
  )) {
    found = { ...found, ...xmlOf(document, member, depth + 1) };
  }
  const own = schema["xml"];
  if (isJsonObject(own)) {
    const info: XmlInfo = {};
    if (typeof own["name"] === "string") info.name = own["name"];
    if (typeof own["namespace"] === "string" && own["namespace"] !== "") {
      info.namespace = own["namespace"];
    }
    if (typeof own["prefix"] === "string" && own["prefix"] !== "")
      info.prefix = own["prefix"];
    if (typeof own["attribute"] === "boolean") info.attribute = own["attribute"];
    if (typeof own["wrapped"] === "boolean") info.wrapped = own["wrapped"];
    found = { ...found, ...info };
  }
  return found;
}

type Kind = XmlNode["type"];

function kindOf(document: OpenApiDocument, schema: JsonValue, depth = 0): Kind {
  const resolved = resolveSchema(document, schema);
  if (!isJsonObject(resolved) || depth > 32) return "any";
  const declared = resolved["type"];
  const types = (Array.isArray(declared) ? declared : [declared]).filter(
    (type): type is string => typeof type === "string" && type !== "null",
  );
  if (types.length === 1) {
    const [type] = types;
    if (
      type === "object" ||
      type === "array" ||
      type === "string" ||
      type === "integer" ||
      type === "number" ||
      type === "boolean"
    ) {
      return type;
    }
    return "any";
  }
  if (types.length > 1) return "any";
  if (isJsonObject(resolved["properties"])) return "object";
  if (resolved["items"] !== undefined) return "array";
  // A choice whose branches are all one kind of value is that kind.
  const branches = [
    ...(Array.isArray(resolved["oneOf"]) ? resolved["oneOf"] : []),
    ...(Array.isArray(resolved["anyOf"]) ? resolved["anyOf"] : []),
  ];
  const kinds = new Set(branches.map((branch) => kindOf(document, branch, depth + 1)));
  const [only] = kinds;
  return kinds.size === 1 && only !== undefined ? only : "any";
}

const SCALARS = new Set<Kind>(["string", "integer", "number", "boolean"]);

/** The description of one side of a body, built place by place. */
class Describer {
  readonly root: XmlNode = { type: "object" };
  readonly issues: ProjectionIssue[] = [];
  readonly document: OpenApiDocument;
  readonly schema: JsonValue;
  readonly reading: boolean;
  readonly where: string;

  constructor(
    document: OpenApiDocument,
    schema: JsonValue,
    reading: boolean,
    where: string,
  ) {
    this.document = document;
    this.schema = schema;
    this.reading = reading;
    this.where = where;
  }

  issue(changeId: string, message: string): void {
    if (
      this.issues.some((each) => each.changeId === changeId && each.message === message)
    ) {
      return;
    }
    this.issues.push({ changeId, message: `${this.where}: ${message}`, xml: true });
  }

  /** The property `key` of an object schema, through its choices where they agree. */
  property(
    schema: JsonValue,
    key: string,
    changeId: string,
    depth = 0,
  ): JsonValue | undefined {
    const resolved = resolveSchema(this.document, schema);
    if (!isJsonObject(resolved) || depth > 32) return undefined;
    const properties = resolved["properties"];
    if (isJsonObject(properties) && Object.hasOwn(properties, key))
      return properties[key];
    const branches = [
      ...(Array.isArray(resolved["oneOf"]) ? resolved["oneOf"] : []),
      ...(Array.isArray(resolved["anyOf"]) ? resolved["anyOf"] : []),
    ];
    const found = branches
      .map((branch) => this.property(branch, key, changeId, depth + 1))
      .filter((each): each is JsonValue => each !== undefined);
    const [first] = found;
    if (first === undefined) return undefined;
    const written = (each: JsonValue) =>
      JSON.stringify([xmlOf(this.document, each), kindOf(this.document, each)]);
    if (found.some((each) => written(each) !== written(first))) {
      this.issue(
        changeId,
        `${key} is written differently in the branches of a choice, so which element it is would be a guess`,
      );
      return undefined;
    }
    return first;
  }

  /** A node for the field `key` holding `schema`, or nothing where it cannot be described. */
  node(
    key: string,
    schema: JsonValue,
    changeId: string,
    item: string | undefined,
  ): XmlNode | undefined {
    const xml = xmlOf(this.document, schema);
    const type = kindOf(this.document, schema);
    const node: XmlNode = { type };
    const name = item ?? xml.name ?? key;
    if (!isNcName(name)) {
      this.issue(
        changeId,
        `${key} would be written as <${name}>, which is not a name XML allows`,
      );
      return undefined;
    }
    if (item !== undefined || name !== key) node.name = name;
    if (xml.namespace !== undefined) node.namespace = xml.namespace;
    if (xml.prefix !== undefined) {
      if (!isNcName(xml.prefix) || xml.prefix === "xmlns") {
        this.issue(
          changeId,
          `${key} has the prefix ${xml.prefix}, which is not one XML allows`,
        );
        return undefined;
      }
      node.prefix = xml.prefix;
    }
    if (xml.attribute === true && item === undefined) {
      if (!SCALARS.has(type)) {
        this.issue(changeId, `${key} is an attribute holding more than a value`);
        return undefined;
      }
      node.attribute = true;
    }
    if (type === "array") {
      if (xml.wrapped === true) node.wrapped = true;
      const resolved = resolveSchema(this.document, schema);
      const itemsSchema = isJsonObject(resolved) ? (resolved["items"] ?? {}) : {};
      const itemsXml = xmlOf(this.document, itemsSchema);
      const items = this.node(
        key,
        itemsSchema,
        changeId,
        itemsXml.name ?? (xml.wrapped === true ? (xml.name ?? key) : key),
      );
      if (items === undefined) return undefined;
      if (items.type === "array") {
        this.issue(changeId, `${key} is a list of lists, which XML has no form for`);
        return undefined;
      }
      node.items = items;
    }
    return node;
  }

  /** Describes every place on the way to `path`, as far as the schema goes. */
  describe(path: readonly string[], changeId: string): void {
    let schema: JsonValue = this.schema;
    let node = this.root;
    for (const [index, segment] of path.entries()) {
      const where = `/${path.slice(0, index + 1).join("/")}`;
      if (segment === "{}") {
        this.issue(changeId, `${where} reads a map's values, which XML has no form for`);
        return;
      }
      if (node.type === "object") {
        if (segment === "*") return;
        const child = this.property(schema, segment, changeId);
        if (child === undefined) return;
        node.properties ??= {};
        let next = node.properties[segment];
        if (next === undefined) {
          const made = this.node(segment, child, changeId, undefined);
          if (made === undefined) return;
          next = made;
          node.properties[segment] = next;
        }
        schema = child;
        node = next;
        continue;
      }
      if (node.type === "array") {
        if (segment !== "*" || node.items === undefined) return;
        const resolved = resolveSchema(this.document, schema);
        schema = isJsonObject(resolved) ? (resolved["items"] ?? {}) : {};
        node = node.items;
        continue;
      }
      if (node.type === "any" && this.reading) {
        this.issue(
          changeId,
          `${where} is inside a value its contract says nothing of, which XML cannot be read into`,
        );
      }
      return;
    }
  }

  /** The node at `path`, where one is described. */
  at(path: readonly string[]): XmlNode | undefined {
    let node: XmlNode | undefined = this.root;
    for (const segment of path) {
      if (node === undefined) return undefined;
      node = segment === "*" ? node.items : node.properties?.[segment];
    }
    return node;
  }
}

/** Two fields an object's description writes as one element are refused, as the runtime refuses them. */
function collisions(node: XmlNode, path: string, found: string[]): void {
  const elements = new Map<string, string>();
  const attributes = new Map<string, string>();
  for (const [key, property] of Object.entries(node.properties ?? {})) {
    const name =
      property.type === "array" && property.wrapped !== true
        ? (property.items?.name ?? key)
        : (property.name ?? key);
    const seen = property.attribute === true ? attributes : elements;
    const identity = `${property.namespace ?? ""} ${name}`;
    const other = seen.get(identity);
    if (other !== undefined)
      found.push(`${path}/${other} and ${path}/${key} are both written as ${name}`);
    seen.set(identity, key);
    collisions(property, `${path}/${key}`, found);
  }
  if (node.items) collisions(node.items, `${path}/*`, found);
}

/**
 * The description of one body a site's `instrs` run over: read as `read`
 * writes it, written as `write` does. Issues name the Change that could not
 * be described, for the release gate.
 */
export function describeXmlBody(
  read: { document: OpenApiDocument; schema: JsonValue },
  write: { document: OpenApiDocument; schema: JsonValue },
  instrs: readonly Instr[],
  blocks: Readonly<Record<string, Instr[]>>,
  where: string,
  envelope = false,
): { body?: XmlBody; issues: ProjectionIssue[] } {
  const steps = envelope ? inBody(stepsOf(instrs, blocks)) : stepsOf(instrs, blocks);
  const reading = new Describer(read.document, read.schema, true, where);
  const writing = new Describer(write.document, write.schema, false, where);
  for (const [side, describer] of [
    ["arrives", reading],
    ["leaves", writing],
  ] as const) {
    if (kindOf(describer.document, describer.schema) !== "object") {
      describer.issue(
        instrs[0]?.c ?? "",
        `the body it ${side} as is not an object, which XML writes as an element holding fields`,
      );
    }
  }
  for (const [index, step] of steps.entries()) {
    if (step.shared !== undefined) {
      reading.issue(
        step.c,
        `the value is served by the shared block ${step.shared}, as a schema that contains itself or sits in too many places is, and an XML body's description has to name every place`,
      );
      continue;
    }
    const earlier = steps.slice(0, index);
    const later = steps.slice(index + 1);
    for (const path of step.touched) {
      reading.describe(traceBack(path, earlier), step.c);
      writing.describe(traceForward(path, later), step.c);
    }
    for (const path of step.reads) {
      const at = traceBack(path, earlier);
      if (reading.at(at)?.type === "any") {
        reading.issue(
          step.c,
          `/${at.join("/")} is read by value, and its contract does not say what it holds, so it cannot be read from XML`,
        );
      }
    }
  }
  const issues = [...reading.issues, ...writing.issues];
  const found: string[] = [];
  collisions(reading.root, "", found);
  collisions(writing.root, "", found);
  for (const message of found) {
    issues.push({
      changeId: instrs[0]?.c ?? "",
      message: `${where}: ${message}`,
      xml: true,
    });
  }
  return issues.length > 0
    ? { issues }
    : { body: { read: reading.root, write: writing.root }, issues };
}

/** A document's operations by method and path. */
function operationsByKey(document: OpenApiDocument): Map<string, JsonObject> {
  const found = new Map<string, JsonObject>();
  for (const each of operationsOf(document)) {
    if (!each.webhook) found.set(siteKey(each.method, each.path), each.operation);
  }
  return found;
}

/** The XML schema a response list keyed `key` answers with: the status, its class, then `default`. */
function responseFor(
  document: OpenApiDocument,
  operation: JsonObject,
  key: string,
): JsonValue | undefined {
  const declared = responseXmlSchemas(document, operation);
  const byStatus = new Map(
    declared.map((entry) => [entry.status.toLowerCase(), entry.schema]),
  );
  const wanted = /^\d{3}$/.test(key)
    ? [key, `${key[0]}xx`, "default"]
    : [key.toLowerCase()];
  for (const status of wanted) {
    const found = byStatus.get(status);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The XML each site of one contract's program reads and writes, where its
 * operation declares XML bodies: requests from `historical`, the contract its
 * callers wrote against, to `current`; responses the other way. `routes`
 * says which historical operation each site's calls come from.
 */
export function describeXmlSites(
  sites: Record<string, SiteProgram>,
  historical: OpenApiDocument,
  current: OpenApiDocument,
  routes: readonly {
    from: { method: string; path: string };
    to: { method: string; path: string };
  }[],
  blocks: Readonly<Record<string, Instr[]>>,
): { sites: Record<string, SiteProgram>; issues: ProjectionIssue[] } {
  const issues: ProjectionIssue[] = [];
  const operationsNow = operationsByKey(current);
  const operationsThen = operationsByKey(historical);
  // Where each site's calls come from, when a route brought them there.
  const cameFrom = new Map<string, string>();
  for (const route of routes) {
    const to = siteKey(route.to.method, route.to.path);
    if (!cameFrom.has(to)) cameFrom.set(to, siteKey(route.from.method, route.from.path));
  }
  const out: Record<string, SiteProgram> = {};
  for (const [key, site] of Object.entries(sites)) {
    const now = operationsNow.get(key);
    const then = operationsThen.get(cameFrom.get(key) ?? key);
    if (now === undefined || then === undefined) {
      out[key] = site;
      continue;
    }
    const xml: XmlProgram = {};
    const requestThen = requestXmlSchema(historical, then);
    const requestNow = requestXmlSchema(current, now);
    // The request's work, over the body alone or over the whole request where
    // a Change reaches a parameter too.
    const requestWork =
      site.envelope?.body === true ? site.envelope.instrs : site.request;
    if (
      requestThen !== undefined &&
      requestWork !== undefined &&
      requestWork.length > 0
    ) {
      if (requestNow === undefined) {
        issues.push({
          changeId: requestWork[0]?.c ?? "",
          message: `${key} request: an old caller's body is XML and the current contract takes none, so it cannot be written for it`,
          xml: true,
        });
      } else {
        const described = describeXmlBody(
          { document: historical, schema: requestThen },
          { document: current, schema: requestNow },
          requestWork,
          blocks,
          `${key} request`,
          site.envelope !== undefined,
        );
        issues.push(...described.issues);
        if (described.body) xml.request = described.body;
      }
    }
    for (const [status, instrs] of Object.entries(site.response ?? {})) {
      if (instrs.length === 0) continue;
      const arrives = responseFor(current, now, status);
      if (arrives === undefined) continue;
      // The status an old caller is answered with, where a rule moves it.
      let shown = status;
      for (const rule of site.status ?? []) {
        if (String(rule.from) === shown) shown = String(rule.to);
      }
      const leaves = responseFor(historical, then, shown);
      if (leaves === undefined) continue;
      const described = describeXmlBody(
        { document: current, schema: arrives },
        { document: historical, schema: leaves },
        instrs,
        blocks,
        `${key} response ${status}`,
      );
      issues.push(...described.issues);
      if (described.body) {
        xml.response ??= {};
        xml.response[status] = described.body;
      }
    }
    out[key] = xml.request || xml.response ? { ...site, xml } : site;
  }
  return { sites: out, issues };
}

const isXmlType = (type: string) => {
  const essence = (type.split(";")[0] ?? "").trim().toLowerCase();
  return (
    essence === "application/xml" || essence === "text/xml" || essence.endsWith("+xml")
  );
};

/**
 * Whether a document declares any request or response body as XML: any
 * `content` of an operation's request or responses, or of a shared one, that
 * names an XML type. Read without resolving anything, since it is asked of
 * every contract in a chain and nearly all of them say no.
 */
export function declaresXml(document: OpenApiDocument): boolean {
  const holders: JsonValue[] = [];
  const paths = document["paths"];
  for (const item of isJsonObject(paths) ? Object.values(paths) : []) {
    if (!isJsonObject(item)) continue;
    for (const operation of Object.values(item)) {
      if (!isJsonObject(operation)) continue;
      holders.push(operation["requestBody"] ?? null);
      const responses = operation["responses"];
      if (isJsonObject(responses)) holders.push(...Object.values(responses));
    }
  }
  const components = document["components"];
  if (isJsonObject(components)) {
    for (const kind of ["requestBodies", "responses"]) {
      const shared = components[kind];
      if (isJsonObject(shared)) holders.push(...Object.values(shared));
    }
  }
  return holders.some((holder) => {
    const content = isJsonObject(holder) ? holder["content"] : undefined;
    return isJsonObject(content) && Object.keys(content).some(isXmlType);
  });
}
