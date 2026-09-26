/**
 * Scenarios from traffic a provider already has: a HAR file saved from a
 * browser or a proxy, or a Postman collection.
 *
 * A document says what an API could be asked. A recording says what someone
 * actually asked it, in the order they asked, with the values a real client
 * sends, which is the traffic whose meaning a release has to keep. So both are
 * read into the same scenarios `invariant/scenarios` holds, and a file a
 * provider writes or edits there stays the last word.
 *
 * The one thing a recording cannot say by itself is which values were minted
 * by the server. A request to `/pets/8f3a...` only replays against a fresh
 * build if the id is the one that build just returned, not the one the
 * recording's server did. So a value an earlier answer carried, found again in
 * a later request, becomes a capture and a `${step.name}` reference, the same
 * way a hand-written scenario links a create to the reads after it.
 *
 * What cannot be replayed faithfully is left out and named, never sent with a
 * guess: a body that is not JSON, a Postman variable only a script it cannot
 * run would have set.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "@invariant-app/ir";
import type { Scenario, ScenarioStep } from "./scenarios.ts";

export interface ImportOptions {
  /** The contract the recorded traffic speaks, which every scenario is written in. */
  contract: string;
  /**
   * Only requests under this are kept: a URL (`https://api.example.com/v1`)
   * or a path prefix (`/v1`). A browser's recording holds its pages, scripts
   * and fonts as well as the API's answers.
   */
  base?: string;
  /** Headers every request carries, such as a test credential. */
  headers?: Record<string, string>;
  /**
   * Headers kept although they are normally dropped, lower case. A recorded
   * credential is dropped by default, because it belongs to whoever made the
   * recording and has usually expired by the time it is replayed.
   */
  keepHeaders?: string[];
  /** Postman: values for `{{variables}}`, before the collection's own. */
  variables?: Record<string, string>;
  /** HAR: the name of the scenario for requests that belong to no page. */
  name?: string;
}

export interface ImportedScenarios {
  scenarios: Scenario[];
  /** Requests left out, each with why, so a reviewer knows what was not asked. */
  skipped: string[];
}

/**
 * Headers that describe the client, the connection or the recording rather
 * than the request's meaning. Replayed, they either say nothing or say
 * something false: a stale cache validator, the recording's content length.
 */
const DROPPED = new Set([
  "accept-encoding",
  "accept-language",
  "authorization",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "dnt",
  "host",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "keep-alive",
  "origin",
  "postman-token",
  "pragma",
  "priority",
  "proxy-authorization",
  "referer",
  "te",
  "upgrade-insecure-requests",
  "user-agent",
]);

function droppedHeader(name: string, keep: ReadonlySet<string>): boolean {
  if (keep.has(name)) return false;
  return (
    DROPPED.has(name) ||
    name.startsWith(":") ||
    name.startsWith("sec-") ||
    name.startsWith("x-forwarded-") ||
    name.startsWith("proxy-")
  );
}

/** A request as read from either format, before it is linked to the others. */
interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: JsonValue | undefined;
  /** What the server answered, when the recording kept it. */
  status: number | undefined;
  response: JsonValue | undefined;
  /** Postman: variables this request's test script sets, name to pointer. */
  sets: Record<string, string>;
  /** The step's id, when a reference to it was written before linking. */
  id?: string;
}

const ID_KEY =
  /^(id|uuid|guid|key|slug|token|handle|name)$|(_id|Id|ID|_uuid|Uuid|_key|Key|_slug)$/;

/**
 * Whether a value an answer carried is one a later request could only have
 * got from that answer. An id-named field counts whatever it holds. Any other
 * string counts when it looks minted rather than chosen: long enough and not
 * a plain word, so a status such as `open` sent back later is left as the
 * constant it is.
 */
function linkable(key: string, value: JsonValue): boolean {
  if (ID_KEY.test(key)) {
    return (typeof value === "string" && value.length > 0) || typeof value === "number";
  }
  return typeof value === "string" && value.length >= 4 && !/^[A-Za-z ]+$/.test(value);
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Every linkable scalar in an answer, with where it is, shallowest first. */
function linkableValues(
  body: JsonValue | undefined,
): { pointer: string; value: JsonValue; key: string }[] {
  const out: { pointer: string; value: JsonValue; key: string; depth: number }[] = [];
  const visit = (node: JsonValue, pointer: string, key: string, depth: number): void => {
    if (depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => {
        visit(entry, `${pointer}/${index}`, key, depth + 1);
      });
      return;
    }
    if (isJsonObject(node)) {
      for (const [name, entry] of Object.entries(node)) {
        visit(entry, `${pointer}/${escapePointer(name)}`, name, depth + 1);
      }
      return;
    }
    if (linkable(key, node)) out.push({ pointer, value: node, key, depth });
  };
  if (body !== undefined) visit(body, "", "", 0);
  // An id-named field before any other, then the shallowest: the id of the
  // thing a create made, not the id of something it happens to mention.
  return out
    .sort(
      (a, b) =>
        Number(!ID_KEY.test(a.key)) - Number(!ID_KEY.test(b.key)) || a.depth - b.depth,
    )
    .map(({ pointer, value, key }) => ({ pointer, value, key }));
}

function stepIdFor(method: string, path: string, taken: Set<string>): string {
  const segments =
    path
      .split("?")[0]
      ?.split("/")
      .filter((segment) => segment !== "" && !segment.includes("${"))
      .map((segment) =>
        segment
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, ""),
      )
      .filter((segment) => segment !== "")
      .slice(-2) ?? [];
  const base = [method.toLowerCase(), ...segments].join("_");
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

function captureName(
  key: string,
  taken: Record<string, string>,
  pointer: string,
): string {
  const base = key.replace(/[^A-Za-z0-9_]/g, "_") || "value";
  let name = base;
  for (let n = 2; taken[name] !== undefined && taken[name] !== pointer; n += 1) {
    name = `${base}_${n}`;
  }
  return name;
}

/**
 * Turns recorded requests into one scenario's steps, with every value an
 * earlier answer minted replaced by a reference to where that answer held it.
 */
function linkSteps(recorded: readonly Recorded[]): ScenarioStep[] {
  const steps: ScenarioStep[] = [];
  const taken = new Set<string>();
  /** Captures an answer could supply, held until a later step is seen to use them. */
  const pending = new Map<
    string,
    { step: ScenarioStep; name: string; pointer: string }
  >();
  /** Earlier answers' values, as text, to the reference that reproduces them. */
  const known = new Map<string, { reference: string; value: JsonValue }>();

  for (const request of recorded) {
    // The reference that reproduces a value an earlier answer carried.
    const use = (text: string): string | undefined => known.get(text)?.reference;

    // The path, segment by segment, and each query value.
    const [pathname, query] = [
      request.path.split("?")[0] ?? "",
      request.path.split("?")[1],
    ];
    const linkedPath = pathname
      .split("/")
      .map((segment) => {
        if (segment === "") return segment;
        let decoded = segment;
        try {
          decoded = decodeURIComponent(segment);
        } catch {
          // Left as recorded.
        }
        return use(decoded) ?? segment;
      })
      .join("/");
    const linkedQuery = query
      ?.split("&")
      .map((pair) => {
        const at = pair.indexOf("=");
        if (at === -1) return pair;
        let value = pair.slice(at + 1);
        try {
          value = decodeURIComponent(value.replaceAll("+", " "));
        } catch {
          return pair;
        }
        const reference = use(value);
        return reference ? `${pair.slice(0, at)}=${reference}` : pair;
      })
      .join("&");
    // Named after the path once linked, so no recorded id ends up in a name.
    const linked =
      linkedQuery === undefined ? linkedPath : `${linkedPath}?${linkedQuery}`;
    const id = request.id ?? stepIdFor(request.method, linked, taken);
    taken.add(id);
    const step: ScenarioStep = {
      id,
      method: request.method,
      path: linked,
      headers: request.headers,
      body: request.body,
      capture: {},
      expectStatus:
        request.status !== undefined && request.status >= 400
          ? request.status
          : undefined,
    };

    // The body, value by value. Only an exact match of the same type: a string
    // "42" sent where an answer had the number 42 is the client's own choice.
    const linkBody = (node: JsonValue): JsonValue => {
      if (Array.isArray(node)) return node.map(linkBody);
      if (isJsonObject(node)) {
        const out: JsonObject = {};
        for (const [key, entry] of Object.entries(node)) out[key] = linkBody(entry);
        return out;
      }
      if (typeof node !== "string" && typeof node !== "number") return node;
      const found = known.get(String(node));
      if (!found || typeof found.value !== typeof node) return node;
      return found.reference;
    };
    if (step.body !== undefined) step.body = linkBody(step.body);

    steps.push(step);

    // A Postman variable a script sets is captured where the script read it;
    // the steps that use it already refer to it by name.
    for (const [name, pointer] of Object.entries(request.sets)) {
      step.capture[name] = pointer;
    }

    // What this answer minted, for the steps after it. The earliest answer to
    // carry a value keeps it: that is where it was made, and a later read
    // that repeats it is only echoing.
    // Names this answer's captures could take, including the script's own,
    // so two fields called `id` at different depths do not share one.
    const names: Record<string, string> = { ...step.capture };
    for (const { pointer, value, key } of linkableValues(request.response)) {
      const text = String(value);
      if (known.has(text)) continue;
      const name = captureName(key, names, pointer);
      names[name] = pointer;
      known.set(text, { reference: `\${${id}.${name}}`, value });
      // Written into the step below only if a later step uses it.
      pending.set(`${id}.${name}`, { step, name, pointer });
    }
  }

  // Captures nothing refers to would only be noise in a file a person edits.
  const used = new Set<string>();
  const collect = (node: JsonValue | undefined): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(/\$\{([A-Za-z0-9_.]+)\}/g))
        used.add(match[1] as string);
    } else if (Array.isArray(node)) node.forEach(collect);
    else if (isJsonObject(node)) Object.values(node).forEach(collect);
  };
  for (const step of steps) {
    collect(step.path);
    collect(step.body);
  }
  for (const [reference, { step, name, pointer }] of pending) {
    if (used.has(reference)) step.capture[name] = pointer;
  }
  return steps;
}

function parseJson(
  text: string | undefined,
): { ok: true; value: JsonValue } | { ok: false } {
  if (text === undefined || text.trim() === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function isJsonMedia(media: string | undefined): boolean {
  return media !== undefined && /\bjson\b|\+json/i.test(media);
}

/** Whether a URL or path falls under the provider's `base`. */
function underBase(url: string, path: string, base: string | undefined): boolean {
  if (base === undefined) return true;
  const trimmed = base.replace(/\/$/, "");
  if (trimmed.startsWith("/"))
    return (
      path === trimmed || path.startsWith(`${trimmed}/`) || path.startsWith(`${trimmed}?`)
    );
  return (
    url === trimmed || url.startsWith(`${trimmed}/`) || url.startsWith(`${trimmed}?`)
  );
}

function headersFrom(
  entries: readonly { name: string; value: string }[],
  options: ImportOptions,
): Record<string, string> {
  const keep = new Set((options.keepHeaders ?? []).map((name) => name.toLowerCase()));
  const out: Record<string, string> = {};
  for (const { name, value } of entries) {
    const lower = name.toLowerCase();
    if (droppedHeader(lower, keep)) continue;
    out[lower] = value;
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Scenarios from a HAR file: one per page the recording names, in the order
 * its requests were sent, and one for requests that belong to no page.
 */
export function scenariosFromHar(
  har: unknown,
  options: ImportOptions,
): ImportedScenarios {
  const log = isJsonObject(har as JsonValue) ? (har as JsonObject)["log"] : undefined;
  if (!isJsonObject(log) || !Array.isArray(log["entries"])) {
    throw new Error("not a HAR file: it has no log.entries");
  }
  const skipped: string[] = [];
  const titles = new Map<string, string>();
  for (const page of Array.isArray(log["pages"]) ? log["pages"] : []) {
    if (!isJsonObject(page) || typeof page["id"] !== "string") continue;
    titles.set(page["id"], text(page["title"]) ?? page["id"]);
  }

  const entries = log["entries"]
    .filter(isJsonObject)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const at = (e: JsonObject) => Date.parse(text(e["startedDateTime"]) ?? "") || 0;
      return at(a.entry) - at(b.entry) || a.index - b.index;
    });

  const groups = new Map<string, Recorded[]>();
  for (const { entry } of entries) {
    const request = entry["request"];
    const response = entry["response"];
    if (!isJsonObject(request)) continue;
    const method = (text(request["method"]) ?? "").toUpperCase();
    const url = text(request["url"]) ?? "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      skipped.push(`${method} ${url}: not an absolute URL`);
      continue;
    }
    const path = `${parsed.pathname}${parsed.search}`;
    if (!underBase(url, path, options.base)) continue;
    const where = `${method} ${path}`;
    if (!METHODS.has(method)) {
      // A browser's CORS preflight is the browser talking, not the client.
      if (method !== "OPTIONS") skipped.push(`${where}: ${method} is not replayed`);
      continue;
    }

    const content = isJsonObject(response) ? response["content"] : undefined;
    const responseMedia = isJsonObject(content) ? text(content["mimeType"]) : undefined;
    let responseText = isJsonObject(content) ? text(content["text"]) : undefined;
    if (
      responseText !== undefined &&
      isJsonObject(content) &&
      content["encoding"] === "base64"
    ) {
      responseText = Buffer.from(responseText, "base64").toString("utf8");
    }
    const answer = parseJson(responseText);

    const post = request["postData"];
    const bodyText = isJsonObject(post) ? text(post["text"]) : undefined;
    const bodyMedia = isJsonObject(post) ? text(post["mimeType"]) : undefined;
    let body: JsonValue | undefined;
    if (bodyText !== undefined && bodyText !== "") {
      const read = parseJson(bodyText);
      if (!read.ok) {
        skipped.push(
          `${where}: its body is ${bodyMedia ?? "not JSON"}, and only JSON bodies are replayed`,
        );
        continue;
      }
      body = read.value;
    }

    // Without a base, the recording's pages, scripts and images are not the
    // API; what is, is whatever sent or answered JSON.
    if (
      options.base === undefined &&
      body === undefined &&
      !isJsonMedia(responseMedia) &&
      !answer.ok
    ) {
      continue;
    }

    const headers = headersFrom(
      (Array.isArray(request["headers"]) ? request["headers"] : [])
        .filter(isJsonObject)
        .flatMap((header) =>
          typeof header["name"] === "string" && typeof header["value"] === "string"
            ? [{ name: header["name"], value: header["value"] }]
            : [],
        ),
      options,
    );

    const status =
      isJsonObject(response) && typeof response["status"] === "number"
        ? response["status"]
        : undefined;
    const pageref = text(entry["pageref"]);
    const group =
      pageref !== undefined && titles.has(pageref)
        ? (titles.get(pageref) as string)
        : (options.name ?? "imported");
    const list = groups.get(group) ?? [];
    list.push({
      method,
      path,
      headers,
      body,
      status: status === 0 ? undefined : status,
      response: answer.ok ? answer.value : undefined,
      sets: {},
    });
    groups.set(group, list);
  }

  const scenarios = [...groups].map(([name, recorded]) => ({
    name,
    contract: options.contract,
    steps: linkSteps(recorded),
    acknowledged: [],
  }));
  return { scenarios, skipped };
}

/** Postman's own values for its dynamic variables would differ every run. */
const DYNAMIC: Record<string, string> = {
  $guid: "00000000-0000-4000-8000-000000000001",
  $randomUUID: "00000000-0000-4000-8000-000000000001",
  $timestamp: "1767225600",
  $isoTimestamp: "2026-01-01T00:00:00.000Z",
  $randomInt: "42",
};

/**
 * The pointer a test script reads a variable from, for the common ways of
 * writing it: `pm.collectionVariables.set("petId", pm.response.json().id)`,
 * or through `const data = pm.response.json()` first. Anything else is a
 * script, which this does not run.
 */
function scriptSets(script: string): { sets: Record<string, string>; unread: string[] } {
  const sets: Record<string, string> = {};
  const unread: string[] = [];
  const holders = new Set([
    "jsonData",
    "data",
    "body",
    "response",
    "res",
    "json",
    "result",
  ]);
  for (const match of script.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*responseBody\s*\))/g,
  )) {
    holders.add(match[1] as string);
  }
  const setter =
    /(?:pm\.(?:environment|collectionVariables|variables|globals)|postman)\.(?:set|setEnvironmentVariable|setGlobalVariable)\(\s*["']([^"']+)["']\s*,\s*([^;\n]+?)\s*\)\s*;?\s*$/gm;
  for (const match of script.matchAll(setter)) {
    const name = match[1] as string;
    const expression = (match[2] as string).trim();
    const chain =
      /^(?:pm\.response\.json\(\)|JSON\.parse\(\s*responseBody\s*\))((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[["'][^"']+["']\])*)$/.exec(
        expression,
      )?.[1] ??
      (() => {
        const held =
          /^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[["'][^"']+["']\])*)$/.exec(
            expression,
          );
        return held && holders.has(held[1] as string) ? held[2] : undefined;
      })();
    if (chain === undefined) {
      unread.push(name);
      continue;
    }
    const pointer = [
      ...chain.matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[["']([^"']+)["']\]/g),
    ]
      .map((part) => `/${escapePointer((part[1] ?? part[2] ?? part[3]) as string)}`)
      .join("");
    sets[name] = pointer;
  }
  return { sets, unread };
}

interface PostmanRequest {
  name: string;
  item: JsonObject;
}

/** Every request under an item, folders flattened in order. */
function requestsUnder(items: JsonValue | undefined, prefix: string): PostmanRequest[] {
  if (!Array.isArray(items)) return [];
  return items.filter(isJsonObject).flatMap((item) => {
    const name = text(item["name"]) ?? "request";
    if (Array.isArray(item["item"]))
      return requestsUnder(item["item"], `${prefix}${name} / `);
    return item["request"] === undefined ? [] : [{ name: `${prefix}${name}`, item }];
  });
}

/**
 * Scenarios from a Postman collection (v2.0 or v2.1): one per top-level
 * folder, and one for the requests at the top, in the collection's order.
 */
export function scenariosFromPostman(
  collection: unknown,
  options: ImportOptions,
): ImportedScenarios {
  const root = collection as JsonValue;
  if (
    !isJsonObject(root) ||
    !isJsonObject(root["info"]) ||
    !Array.isArray(root["item"])
  ) {
    throw new Error("not a Postman collection: it has no info and item");
  }
  const skipped: string[] = [];
  const title = text(root["info"]["name"]) ?? "collection";

  const declared = new Map<string, string>();
  for (const variable of Array.isArray(root["variable"]) ? root["variable"] : []) {
    if (!isJsonObject(variable) || typeof variable["key"] !== "string") continue;
    const value = variable["value"];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      declared.set(variable["key"], String(value));
    }
  }
  for (const [name, value] of Object.entries(options.variables ?? {}))
    declared.set(name, value);

  const groups: { name: string; requests: PostmanRequest[] }[] = [];
  const top: PostmanRequest[] = [];
  for (const item of root["item"].filter(isJsonObject)) {
    const name = text(item["name"]) ?? "request";
    if (Array.isArray(item["item"])) {
      groups.push({ name, requests: requestsUnder(item["item"], "") });
    } else if (item["request"] !== undefined) {
      top.push({ name, item });
    }
  }
  if (top.length > 0) groups.unshift({ name: title, requests: top });

  const scenarios: Scenario[] = [];
  for (const group of groups) {
    // Variables a script in this scenario sets, name to the reference that
    // replaces `{{name}}` once the step that sets it has run.
    const captured = new Map<string, string>();
    const recorded: Recorded[] = [];
    const scripted = new Set<string>();
    for (const { item } of group.requests) {
      for (const event of Array.isArray(item["event"]) ? item["event"] : []) {
        if (!isJsonObject(event) || event["listen"] !== "test") continue;
        const script = isJsonObject(event["script"])
          ? event["script"]["exec"]
          : undefined;
        const lines = Array.isArray(script)
          ? script.filter((line) => typeof line === "string").join("\n")
          : (text(script) ?? "");
        const read = scriptSets(lines);
        for (const name of [...Object.keys(read.sets), ...read.unread])
          scripted.add(name);
      }
    }

    // Read in order, since a variable's reference exists only once the step
    // that sets it has been read.
    const ids = new Set<string>();
    for (const { name, item } of group.requests) {
      const read = readPostmanRequest(item, declared, captured, options);
      if ("skip" in read) {
        skipped.push(`${group.name} / ${name}: ${read.skip}`);
        continue;
      }
      if (read.unresolved.length > 0) {
        const why = read.unresolved.map((variable) =>
          scripted.has(variable)
            ? `{{${variable}}} is set by a script this cannot read`
            : `{{${variable}}} has no value; give it one with a variable`,
        );
        skipped.push(`${group.name} / ${name}: ${why.join("; ")}`);
        continue;
      }
      const id = stepIdFor(read.recorded.method, read.recorded.path, ids);
      for (const variable of Object.keys(read.recorded.sets)) {
        captured.set(variable, `\${${id}.${variable}}`);
      }
      recorded.push({ ...read.recorded, id });
    }
    if (recorded.length === 0) continue;
    scenarios.push({
      name: group.name,
      contract: options.contract,
      steps: linkSteps(recorded),
      acknowledged: [],
    });
  }
  return { scenarios, skipped };
}

function readPostmanRequest(
  item: JsonObject,
  declared: ReadonlyMap<string, string>,
  captured: ReadonlyMap<string, string>,
  options: ImportOptions,
): { recorded: Recorded; unresolved: string[] } | { skip: string } {
  const unresolved = new Set<string>();
  const fill = (value: string, track = true): string =>
    value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, name: string) => {
      const reference = captured.get(name);
      if (reference !== undefined) return reference;
      const known = declared.get(name) ?? DYNAMIC[name];
      if (known !== undefined) return known;
      if (track) unresolved.add(name);
      return whole;
    });
  // A leading `{{baseUrl}}` nobody gave a value is the host, and is dropped
  // rather than reported: the scenario is sent to whichever build is running.
  const hostless = (raw: string): string =>
    raw.replace(/^\{\{[^}]+\}\}/, (whole) =>
      declared.has(whole.slice(2, -2).trim()) ? whole : "",
    );

  const raw = item["request"];
  const request: JsonObject =
    typeof raw === "string" ? { url: raw, method: "GET" } : isJsonObject(raw) ? raw : {};
  const method = (text(request["method"]) ?? "GET").toUpperCase();
  if (!METHODS.has(method)) return { skip: `${method} is not replayed` };

  // The path, from the structured URL when there is one, so the host, which
  // is where the recording ran rather than what it asked, never enters it.
  const url = request["url"];
  let path: string;
  let full: string;
  if (isJsonObject(url) && url["path"] !== undefined) {
    const segments = Array.isArray(url["path"])
      ? url["path"].map((segment) =>
          typeof segment === "string"
            ? segment
            : isJsonObject(segment)
              ? (text(segment["value"]) ?? "")
              : "",
        )
      : [text(url["path"]) ?? ""];
    const pathVariables = new Map<string, string>();
    for (const variable of Array.isArray(url["variable"]) ? url["variable"] : []) {
      if (isJsonObject(variable) && typeof variable["key"] === "string") {
        pathVariables.set(variable["key"], String(variable["value"] ?? ""));
      }
    }
    path = `/${segments
      .map((segment) =>
        segment.startsWith(":") && pathVariables.has(segment.slice(1))
          ? (pathVariables.get(segment.slice(1)) as string)
          : segment,
      )
      .map((segment) => fill(segment))
      .join("/")}`.replace(/\/+/g, "/");
    const query = (Array.isArray(url["query"]) ? url["query"] : [])
      .filter(isJsonObject)
      .filter((entry) => entry["disabled"] !== true && typeof entry["key"] === "string")
      .map((entry) => `${entry["key"] as string}=${fill(String(entry["value"] ?? ""))}`);
    if (query.length > 0) path = `${path}?${query.join("&")}`;
    // Only to decide whether it is under `base`: what the request sends is
    // the path above, so a variable only the host uses is not a reason to skip.
    full = fill(hostless(text(url["raw"]) ?? path), false);
  } else {
    const rawUrl = isJsonObject(url) ? (text(url["raw"]) ?? "") : (text(url) ?? "");
    full = fill(hostless(rawUrl));
    // Not through URL, which would percent-encode the references just written.
    const local = full.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/#.*$/, "");
    path = local.startsWith("/") ? local : `/${local}`;
  }
  if (!underBase(full, path.split("?")[0] ?? path, options.base)) {
    return { skip: `not under ${options.base}` };
  }

  const headers = headersFrom(
    (Array.isArray(request["header"]) ? request["header"] : [])
      .filter(isJsonObject)
      .filter((header) => header["disabled"] !== true)
      .flatMap((header) =>
        typeof header["key"] === "string" && typeof header["value"] === "string"
          ? [{ name: header["key"], value: fill(header["value"]) }]
          : [],
      ),
    options,
  );

  let body: JsonValue | undefined;
  const rawBody = request["body"];
  if (isJsonObject(rawBody) && rawBody["disabled"] !== true) {
    const mode = text(rawBody["mode"]);
    if (mode === "raw") {
      const source = text(rawBody["raw"]) ?? "";
      if (source.trim() !== "") {
        // Filled before parsing, as Postman does, so `{{id}}` inside a string
        // and a bare `{{count}}` both work.
        const read = parseJson(fill(source));
        if (!read.ok)
          return { skip: "its body is not JSON, and only JSON bodies are replayed" };
        body = read.value;
      }
    } else if (mode !== undefined && mode !== "none") {
      return { skip: `its body is ${mode}, and only JSON bodies are replayed` };
    }
  }

  // A saved example's answer, when the collection kept one, says what the
  // request returned, which is what links it to the requests after it.
  let response: JsonValue | undefined;
  let status: number | undefined;
  const examples = Array.isArray(item["response"])
    ? item["response"].filter(isJsonObject)
    : [];
  const example = examples[0];
  if (example) {
    const read = parseJson(text(example["body"]));
    if (read.ok) response = read.value;
    if (typeof example["code"] === "number") status = example["code"];
  }

  const sets: Record<string, string> = {};
  for (const event of Array.isArray(item["event"]) ? item["event"] : []) {
    if (!isJsonObject(event) || event["listen"] !== "test") continue;
    const script = isJsonObject(event["script"]) ? event["script"]["exec"] : undefined;
    const lines = Array.isArray(script)
      ? script.filter((line) => typeof line === "string").join("\n")
      : (text(script) ?? "");
    Object.assign(sets, scriptSets(lines).sets);
  }

  return {
    recorded: { method, path, headers, body, status, response, sets },
    unresolved: [...unresolved],
  };
}
