/**
 * An operation that answers with another success status: the `status` op.
 *
 * Three things read it. The prediction moves the old contract's response from
 * the status it was promised at to the one the operation answers with now,
 * so the gate compares the body and headers that response carries as it would
 * any other. The projection gives the old contract's site a rule that answers
 * an old caller the status it was promised. And the response work of the
 * release's other Changes, written against the old contract's status, is
 * filed under the status the provider now answers with, which is the one the
 * runtime reads when the answer arrives.
 *
 * What happens to the body is read from the two contracts rather than
 * declared, so it cannot be declared wrong: where the old contract promised no
 * body, the caller is sent none; where it promised one and the new status
 * carries one, the body is served like any other; where it promised one and
 * the new status carries none, nothing can stand in for it and the Change is
 * refused.
 */
import { type OpenApiDocument, operationsOf, resolveRef } from "@invariant-app/contract";
import {
  type Change,
  isJsonObject,
  type JsonObject,
  type StatusOp,
  type StatusRule,
} from "@invariant-app/ir";
import { mapEndpoint, type PredictionIssue, type RouteMapping } from "./predict.ts";

export interface StatusMapping {
  /** The operation as the old contract names it. */
  method: string;
  path: string;
  /** The status the old contract promised, and the one the operation answers with now. */
  from: string;
  to: string;
  changeId: string;
}

export function statusMappings(changes: readonly Change[]): StatusMapping[] {
  const out: StatusMapping[] = [];
  for (const change of changes) {
    for (const op of change.ops) {
      if (op.op !== "status") continue;
      out.push({
        method: op.endpoint.method,
        path: op.endpoint.path,
        from: op.from,
        to: op.to,
        changeId: change.id,
      });
    }
  }
  return out;
}

/**
 * The status an old operation's response is answered with now: the status a
 * Change moved it to, or the one it always had.
 */
export function statusNow(
  mappings: readonly StatusMapping[],
  method: string,
  path: string,
  status: string,
): string {
  const moved = mappings.find(
    (mapping) =>
      mapping.method === method.toLowerCase() &&
      mapping.path === path &&
      mapping.from === status,
  );
  return moved?.to ?? status;
}

function operationAt(
  document: OpenApiDocument,
  endpoint: { method: string; path: string },
): JsonObject | undefined {
  return operationsOf(document).find(
    (candidate) =>
      !candidate.webhook &&
      candidate.method === endpoint.method &&
      candidate.path === endpoint.path,
  )?.operation;
}

/** The response an operation declares at an exact status, with a shared one followed to what it names. */
function responseAt(
  document: OpenApiDocument,
  operation: JsonObject,
  status: string,
): JsonObject | undefined {
  const responses = operation["responses"];
  if (!isJsonObject(responses)) return undefined;
  let response = responses[status];
  for (
    let hops = 0;
    isJsonObject(response) && typeof response["$ref"] === "string" && hops < 16;
    hops += 1
  ) {
    response = resolveRef(document, response["$ref"]);
  }
  return isJsonObject(response) ? response : undefined;
}

/** Whether a response promises a body, in any representation. */
function carriesBody(response: JsonObject): boolean {
  const content = response["content"];
  return isJsonObject(content) && Object.keys(content).length > 0;
}

const label = (op: StatusOp) => `${op.endpoint.method.toUpperCase()} ${op.endpoint.path}`;

/**
 * Why the op cannot be served as written, if it cannot: checked against the
 * old contract, and against the new one where there is one.
 */
export function statusProblem(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument | undefined,
  routes: readonly RouteMapping[],
  op: StatusOp,
): string | undefined {
  if (op.from === op.to)
    return `${label(op)} answers ${op.from} either way, so nothing changed`;
  const old = operationAt(oldContract, op.endpoint);
  if (!old) return `${label(op)} is not an operation of the old contract`;
  const promised = responseAt(oldContract, old, op.from);
  if (!promised) {
    return `${label(op)} never answered ${op.from} in the old contract, so no old caller was promised it`;
  }
  if (!newContract) return undefined;
  const target = mapEndpoint(routes, op.endpoint.method, op.endpoint.path);
  const now = operationAt(newContract, target);
  if (!now) {
    return `${target.method.toUpperCase()} ${target.path} is not an operation of the new contract`;
  }
  const answered = responseAt(newContract, now, op.to);
  if (!answered) {
    return `${target.method.toUpperCase()} ${target.path} does not answer ${op.to} in the new contract`;
  }
  if (responseAt(newContract, now, op.from)) {
    return (
      `${target.method.toUpperCase()} ${target.path} still answers ${op.from} in the new ` +
      `contract, so it did not become ${op.to}`
    );
  }
  if (carriesBody(promised) && !carriesBody(answered)) {
    return (
      `old callers were promised a body with ${op.from}, and ${op.to} carries none, ` +
      "so nothing can be sent in its place"
    );
  }
  return undefined;
}

/**
 * The old contract's response moved to the status the operation answers with
 * now, in the predicted document, as the op's half of the closure check.
 */
export function applyStatus(
  document: OpenApiDocument,
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument,
  routes: readonly RouteMapping[],
  op: StatusOp,
  issues: PredictionIssue[],
  changeId: string,
): void {
  const problem = statusProblem(oldContract, newContract, routes, op);
  if (problem) {
    issues.push({ changeId, message: problem });
    return;
  }
  const target = mapEndpoint(routes, op.endpoint.method, op.endpoint.path);
  const operation = operationAt(document, target);
  const responses = operation?.["responses"];
  if (!isJsonObject(responses) || responses[op.from] === undefined) {
    issues.push({
      changeId,
      message: `${label(op)} has no ${op.from} response left in the predicted contract to move`,
    });
    return;
  }
  // As it was declared, shared or not: only the status it is keyed by moves.
  // Where the old contract listed the new status as well, as Gitea 1.24 listed
  // 201 beside the 204 its server answered, an old caller is now answered
  // `from` wherever the operation answers `to`, so what the old contract said
  // of `to` is no longer what any old caller is sent.
  responses[op.to] = responses[op.from] as JsonObject;
  delete responses[op.from];
}

/** The rule an old caller's answers are given, where the op can be served. */
export function statusRule(
  oldContract: OpenApiDocument,
  newContract: OpenApiDocument | undefined,
  routes: readonly RouteMapping[],
  op: StatusOp,
  changeId: string,
): StatusRule | undefined {
  if (statusProblem(oldContract, newContract, routes, op) !== undefined) return undefined;
  const old = operationAt(oldContract, op.endpoint) as JsonObject;
  const promised = responseAt(oldContract, old, op.from) as JsonObject;
  return {
    from: Number(op.to),
    to: Number(op.from),
    ...(carriesBody(promised) ? {} : { empty: true as const }),
    c: changeId,
  };
}
