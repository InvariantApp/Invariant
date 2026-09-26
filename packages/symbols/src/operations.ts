/**
 * Pairs each of a contract's operations with the SDK method that calls it.
 *
 * A generated method's body says what it requests, whatever the generator:
 * `self._post("/v1/messages")`, `this._makeRequest('GET', \`/v1/invoices/${id}\`)`,
 * `method="POST", path="/v1/chat"`, `http.MethodPost` beside
 * `"v1/messages"`. The readers find each verb and path and put `{}` where
 * the path interpolates; here they are laid over the contract's own
 * templates, where `{invoice}` is also `{}`. Where the SDK records the
 * operation's id beside the call, as Speakeasy does, the id decides.
 */
import { type OpenApiDocument, operationsOf } from "@invariant-app/contract";
import type { JsonObject } from "@invariant-app/ir";
import type { CallSite, OperationEntry } from "./types.ts";

/** A path with every parameter as `{}` and no leading or trailing slash. */
export function normalizePath(path: string): string {
  return path
    .replace(/#.*$/, "")
    .replace(/\$\{[^}]*\}|\{[^}]*\}|%[sdvq]/g, "{}")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/|\/(?=\?|$)/g, "");
}

/** The path each server URL adds, as `v1` for `https://api.example.com/v1`. */
function serverPaths(document: OpenApiDocument): string[] {
  const servers = Array.isArray(document["servers"]) ? document["servers"] : [];
  const out: string[] = [];
  for (const server of servers) {
    const url =
      typeof server === "object" && server !== null && !Array.isArray(server)
        ? server["url"]
        : undefined;
    if (typeof url !== "string") continue;
    const path = normalizePath(url.replace(/^[a-z]+:\/\/[^/]*/i, ""));
    if (path !== "") out.push(path);
  }
  return out;
}

/**
 * A wrapper a consumer does not name: an async twin, Stainless's
 * `WithRawResponse`, Fern's `RawV2Client` behind `V2Client`.
 */
const WRAPPER = /^(?:Async|Raw)[A-Z]|(?:Raw|With(?:Raw|Streaming)Response)$/;

/**
 * Orders calls so the one a consumer would name comes first: declared as
 * data, public, not a wrapper, making the call itself or through a helper
 * named for it (Speakeasy's `Chat.complete` through `chatComplete`, where a
 * hand-written `Chat.parse` goes through it too; openapi-generator's
 * `DeleteIdentity` through `DeleteIdentityExecute`), then the shortest name.
 */
function rank(call: CallSite): (number | string)[] {
  // Methods declared as data keep the order the SDK declares them in, where
  // the one it lists first is the one it means: stripe-node 12 declares
  // `cancel` and then its deprecated alias `del` for the same request.
  if (call.declared) return [0];
  const last = call.type.split(".").at(-1) ?? call.type;
  const helper = call.through?.split(".").at(-1)?.toLowerCase();
  const namedAfter =
    helper === undefined ||
    helper.replace(/_/g, "").includes(call.method.toLowerCase().replace(/_/g, ""));
  return [
    call.declared ? 0 : 1,
    call.method.startsWith("_") ? 1 : 0,
    WRAPPER.test(last) ? 1 : 0,
    namedAfter ? 0 : 1,
    call.method.length,
    call.type.split(".").length,
    `${call.type}.${call.method}`,
  ];
}

/**
 * The SDK method name a generator's extension on an operation gives it:
 * Fern's `x-fern-sdk-method-name` beside `x-fern-sdk-group-name`, and
 * Speakeasy's `x-speakeasy-name-override` beside `x-speakeasy-group`.
 */
interface Hint {
  method: string;
  group?: string;
  extension: string;
}

function hintOf(operation: JsonObject): Hint | undefined {
  for (const [extension, group] of [
    ["x-fern-sdk-method-name", "x-fern-sdk-group-name"],
    ["x-speakeasy-name-override", "x-speakeasy-group"],
  ] as const) {
    const method = operation[extension];
    if (typeof method !== "string" || method === "") continue;
    const named = operation[group];
    return {
      method,
      ...(typeof named === "string" && named !== "" ? { group: named } : {}),
      extension,
    };
  }
  return undefined;
}

const bare = (name: string) => name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

/** Whether a call is the method an operation's extension names. */
function fits(hint: Hint, call: CallSite): boolean {
  if (bare(call.method) !== bare(hint.method)) return false;
  return hint.group === undefined || bare(call.type).includes(bare(hint.group));
}

function compare(a: CallSite, b: CallSite): number {
  const [x, y] = [rank(a), rank(b)];
  for (let index = 0; index < x.length; index += 1) {
    const [p, q] = [x[index] as number | string, y[index] as number | string];
    if (p < q) return -1;
    if (p > q) return 1;
  }
  return 0;
}

/**
 * The SDK method for each operation, keyed `method path` as the contract
 * spells it (`get /v1/invoices/upcoming`).
 */
export function matchOperations(
  document: OpenApiDocument,
  calls: readonly CallSite[],
): Record<string, OperationEntry> {
  const byShape = new Map<string, string>();
  const byId = new Map<string, string>();
  const hints = new Map<string, Hint>();
  for (const operation of operationsOf(document)) {
    if (operation.webhook) continue;
    const key = `${operation.method} ${operation.path}`;
    byId.set(operation.operationId, key);
    const hint = hintOf(operation.operation);
    if (hint) hints.set(key, hint);
    // Two templates that differ only in parameter names are one route, and
    // a query the contract's key carries (Anthropic's `?beta=true`) tells
    // two operations on one path apart only when the SDK writes it too.
    for (const shape of [
      normalizePath(operation.path),
      normalizePath(operation.path).replace(/\?.*$/, ""),
    ]) {
      if (!byShape.has(`${operation.method} ${shape}`)) {
        byShape.set(`${operation.method} ${shape}`, key);
      }
    }
  }
  const prefixes = serverPaths(document);
  const found = new Map<string, { call: CallSite; byId: boolean }[]>();
  for (const call of calls) {
    const identified = call.operationId ? byId.get(call.operationId) : undefined;
    if (identified) {
      found.set(identified, [...(found.get(identified) ?? []), { call, byId: true }]);
      continue;
    }
    const path = normalizePath(call.path);
    const bare = path.replace(/\?.*$/, "");
    const tries = [
      path,
      bare,
      ...prefixes.flatMap((prefix) =>
        bare.startsWith(`${prefix}/`) ? [bare.slice(prefix.length + 1)] : [],
      ),
      ...prefixes.map((prefix) => `${prefix}/${bare}`),
    ];
    for (const each of tries) {
      const operation = byShape.get(`${call.verb} ${each}`);
      if (operation === undefined) continue;
      found.set(operation, [...(found.get(operation) ?? []), { call, byId: false }]);
      break;
    }
  }
  const out: Record<string, OperationEntry> = {};
  for (const [operation, callers] of [...found].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const hint = hints.get(operation);
    const agrees = (call: CallSite) => (hint ? fits(hint, call) : false);
    const sorted = [...callers].sort(
      (a, b) =>
        Number(agrees(b.call)) - Number(agrees(a.call)) || compare(a.call, b.call),
    );
    const { call: chosen, byId: identified } = sorted[0] as {
      call: CallSite;
      byId: boolean;
    };
    const others =
      new Set(sorted.map(({ call }) => `${call.type}.${call.method}`)).size - 1;
    const named = hint !== undefined && agrees(chosen);
    const recorded = chosen.declared || identified || named;
    const how = chosen.declared
      ? `the SDK declares ${chosen.type}.${chosen.method} as ${chosen.verb.toUpperCase()} ${chosen.path}`
      : identified
        ? `${chosen.type}.${chosen.method} records the operation's id, ${chosen.operationId}`
        : named
          ? `${chosen.type}.${chosen.method} requests ${chosen.verb.toUpperCase()} ${chosen.path}, and the contract's \`${hint.extension}\` names the method ${hint.method}`
          : `${chosen.type}.${chosen.method} requests ${chosen.verb.toUpperCase()} ${chosen.path}`;
    out[operation] = {
      type: chosen.type,
      method: chosen.method,
      via: recorded ? "metadata" : "structure",
      confidence: recorded ? 1 : others > 0 ? 0.8 : 0.9,
      evidence:
        how +
        (chosen.through ? `, through ${chosen.through}` : "") +
        (others > 0 ? `; ${others} other methods make the same request` : ""),
      ...(chosen.package !== undefined ? { package: chosen.package } : {}),
      file: chosen.file,
    };
  }
  return out;
}
