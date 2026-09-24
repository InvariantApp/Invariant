/**
 * The provider-side compatibility runtime.
 *
 * It runs inside the provider's own process, in two stages. Path rewriting has
 * to happen before routing so an old URL reaches the canonical handler; body
 * rewriting has to happen after authentication so that a signature computed
 * over the bytes the client sent is still verified against those bytes. Putting
 * both in one place would break one of the two.
 *
 * Nothing here reaches the network, reads a file, or consults a model. The
 * compiled program ships inside the provider's build, so an adapter deploys and
 * rolls back with the code it belongs to.
 */

import { programDigest } from "./digest.ts";
import { closeEnvelope, type EnvelopeRequest, openEnvelope } from "./envelope.ts";
import {
  BodyTooLargeError,
  DEFAULT_ERROR_SHAPER,
  ERROR_ID_HEADER,
  type ErrorShaper,
  errorIdOf,
  responseFailure,
} from "./errors.ts";
import { closeForm, formRoots, isFormMediaType, openForm } from "./form.ts";
import {
  appendVary,
  headersForText,
  isJsonMediaType,
  markEtag,
  readBodyText,
  responseOf,
  unmarkConditionals,
  withoutBody,
} from "./http.ts";
import {
  type CompiledInstr,
  DEFAULT_LIMITS,
  type ExecuteLimits,
  execute,
  MatchLimitError,
  TimeBudgetError,
  TransformError,
  touchedPaths,
} from "./interpreter.ts";
import { type Json, type NumberFidelity, parseJson, stringifyJson } from "./json.ts";
import {
  type DecodedContract,
  type DecodedProgram,
  type DecodedSite,
  decodeProgram,
  EMPTY_STATUSES,
  fillTemplate,
  findSite,
  type IdentityStrategy,
  matchTemplate,
  PROGRAM_VERSION,
  ProgramError,
  ProgramTooNewError,
} from "./program.ts";
import { closeXml, isXmlMediaType, openXml, type XmlBody } from "./xml.ts";

export {
  CodecRefusal,
  convertCase,
  convertTime,
  type StringCase,
  type TimeFormat,
} from "./codecs.ts";
/** The digest `invariant compile` records in invariant.lock, for checking a program by. */
export { programDigest } from "./digest.ts";
export type { EnvelopeRequest, ParamCodec } from "./envelope.ts";
export {
  BodyTooDeepError,
  BodyTooLargeError,
  DEFAULT_ERROR_SHAPER,
  ERROR_CODES,
  ERROR_ID_HEADER,
  type ErrorShaper,
  errorIdOf,
  goneWith,
  newErrorId,
  requestFailure,
  responseFailure,
  type ShapedError,
  UnsupportedEncodingError,
} from "./errors.ts";
export {
  appendVary,
  type BodyText,
  headersForText,
  isJsonMediaType,
  markEtag,
  type ReadOptions,
  readBodyText,
  responseOf,
  unmarkConditionals,
} from "./http.ts";
export { type ParameterValues, readParameters, writeParameters } from "./parameters.ts";
/** This runtime's version, which a program's `minRuntime` is compared against. */
export { VERSION as RUNTIME_VERSION } from "./version.ts";
export {
  isNcName,
  isXmlMediaType,
  type XmlBody,
  XmlBodyError,
  type XmlNode,
} from "./xml.ts";
export type { DecodedProgram, DecodedSite };
// matchTemplate is the rule the runtime routes by, for anything that has to agree with it.
export {
  decodeProgram,
  MatchLimitError,
  matchTemplate,
  PROGRAM_VERSION,
  ProgramError,
  ProgramTooNewError,
  TimeBudgetError,
  TransformError,
};

/** A request as the provider's handler should receive it. */
export interface AdaptedRequest {
  path: string;
  /** With its `?`, or empty. */
  search: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | string | null;
}

function pathsOfInstr(instr: CompiledInstr): readonly (readonly string[])[] {
  return touchedPaths(instr);
}

/** A transformed body, and the paths at which a value was folded to produce it. */
export interface Transformed {
  body: string;
  /** Slash-joined paths. Empty when nothing was substituted. */
  folded: string[];
}

/**
 * The response header naming folded fields.
 *
 * Present only when a fold fired, so its absence is a guarantee rather than an
 * omission: a caller who sees no header was shown values their contract names
 * because those were the values the API produced.
 */
export const FOLDED_HEADER = "invariant-folded";

/** Header stage one uses to tell stage two what it concluded. */
export const CONTRACT_HINT_HEADER = "x-invariant-contract-hint";
export const CONTRACT_RESPONSE_HEADER = "invariant-contract";
const INTERNAL_PREFIX = "x-invariant-";

export type { IdentityStrategy } from "./program.ts";

export type ContractSource = "header" | "urlPrefix" | "principal" | "default" | "route";

export interface ContractResolution {
  label: string;
  source: ContractSource;
}

export interface UsageEvent {
  contract: string;
  operation: string;
  consumer: string | undefined;
  /** How many times each Change was applied on this request. */
  changes: Map<string, number>;
}

export interface RuntimeFlags {
  /** Stops all compatibility work. Old contracts are refused rather than mis-served. */
  allDisabled?: boolean;
  disabledContracts?: readonly string[];
  disabledChanges?: readonly string[];
}

export interface RuntimeOptions {
  /** The compiled program, as shipped in the provider's build. */
  program: unknown;
  /**
   * The digest `invariant compile` recorded in `invariant.lock` beside the
   * program. Given, a program that does not hash to it is refused at load
   * with a `ProgramError`, so one edited or swapped after it was reviewed is
   * never served.
   */
  programDigest?: string;
  /**
   * How a request names its contract. Absent means the program's own, which
   * `invariant compile` takes from `invariant.yaml`.
   */
  identity?: readonly IdentityStrategy[];
  /** Largest body the runtime will buffer on a site that needs transforming. */
  maxBodyBytes?: number;
  limits?: ExecuteLimits;
  /**
   * How much numeric precision to carry through a transform. The default is
   * exact for every amount a double can hold, which is every amount the
   * provider's own handler can read. Set `preserve` only if bodies are parsed
   * with arbitrary precision the whole way through; it costs several times a
   * plain parse.
   */
  numbers?: NumberFidelity;
  flags?: () => RuntimeFlags;
  onUsage?: (event: UsageEvent) => void;
  /**
   * Where the fate of each adapted request and response is reported.
   *
   * This is what E9 evidence is built from. Without it a release can say what
   * was proved before deploying and nothing at all about what happened after.
   */
  onOutcome?: (event: OutcomeEvent) => void;
}

/**
 * Every Change a list of instructions can run, through the blocks it nests
 * and the blocks it calls. An older contract reaches the later steps' work by
 * calling it, so a switch that looked only at the instructions written in the
 * site would miss every Change but the oldest step's.
 */
function changesIn(
  instrs: readonly CompiledInstr[],
  into: Set<string>,
  entered: Set<object> = new Set(),
): Set<string> {
  for (const instr of instrs) {
    into.add(instr.c);
    switch (instr.k) {
      case "within":
      case "has":
      case "is":
        changesIn(instr.block, into, entered);
        break;
      case "switch":
        for (const block of instr.cases.values()) changesIn(block, into, entered);
        break;
      case "call":
        if (entered.has(instr.target)) break;
        entered.add(instr.target);
        changesIn(instr.target.instrs, into, entered);
        break;
      default:
        break;
    }
  }
  return into;
}

export class UnsupportedContractError extends Error {
  readonly contract: string;

  constructor(contract: string, reason: string, message?: string) {
    super(message ?? `Contract ${contract} cannot be served right now: ${reason}`);
    this.name = "UnsupportedContractError";
    this.contract = contract;
  }

  /**
   * A caller named a contract that does not exist.
   *
   * Worded apart from the kill-switch case on purpose. "Cannot be served right
   * now" is true of a contract an operator switched off and false of a typo,
   * and a caller reading it would wait for something that is never coming back
   * instead of checking the one character they got wrong.
   */
  static unknown(contract: string, known: readonly string[]): UnsupportedContractError {
    const list =
      known.length === 1
        ? (known[0] as string)
        : `${known.slice(0, -1).join(", ")} and ${known.at(-1) as string}`;
    return new UnsupportedContractError(
      contract,
      "unknown",
      `No contract is called "${contract}". This API serves ${list}.`,
    );
  }
}

/**
 * A caller reached an endpoint that no longer exists.
 *
 * Separate from `UnsupportedContractError` because the answer is different. An
 * unsupported contract might come back; a retired endpoint will not, and the
 * caller needs to know that rather than retry. A bare 404 says neither, and is
 * indistinguishable from a typo in the path.
 */
/**
 * What a provider answers for an operation it no longer serves, and nothing
 * else. A 404 is left out on purpose: it also means a record that does not
 * exist, and turning that into "this operation was retired" would tell a
 * caller something false about an operation that still works.
 */
export const GONE_STATUSES: ReadonlySet<number> = new Set([405, 410]);

export class RetiredEndpointError extends Error {
  readonly contract: string;
  readonly changeId: string;
  readonly guidance: string | undefined;

  constructor(
    contract: string,
    method: string,
    path: string,
    changeId: string,
    guidance?: string,
  ) {
    super(
      `${method.toUpperCase()} ${path} was retired after contract ${contract}` +
        (guidance ? `. ${guidance}` : ". Nothing replaced it."),
    );
    this.name = "RetiredEndpointError";
    this.contract = contract;
    this.changeId = changeId;
    this.guidance = guidance;
  }
}

/**
 * A handler asked about a behaviour flag no Change declares.
 *
 * Almost always a typo, and the reason this throws rather than answering
 * `false`: answering would mean every caller silently gets the new behaviour,
 * including the ones the flag exists to protect, and nothing would ever say so.
 */
export class UnknownBehaviorError extends Error {
  constructor(flag: string, known: readonly string[]) {
    super(
      `No Change declares the behaviour flag "${flag}". ` +
        (known.length > 0
          ? `Declared flags: ${known.join(", ")}.`
          : "This program declares none."),
    );
    this.name = "UnknownBehaviorError";
  }
}

/**
 * What happened to one adapted request or response.
 *
 * Separate from `UsageEvent`, which counts how often each Change was applied.
 * This counts attempts and how they ended, and the distinction is the whole
 * point: an error count with no denominator is a number nobody can act on.
 * "Fourteen failures" means nothing until you know whether it is fourteen out
 * of twenty or fourteen out of four million.
 */
export interface OutcomeEvent {
  contract: string;
  operation: string;
  consumer: string | undefined;
  /** `outbound` is a webhook or callback payload the provider sends. */
  direction: "request" | "response" | "outbound";
  /**
   * `adapted`: the body was rewritten and the caller got their own shape.
   * `refused`: the request never reached the handler, so nothing happened.
   * `failed`: the operation ran and its result could not be expressed in the
   * caller's contract, which is the one that costs somebody something.
   */
  outcome: "adapted" | "refused" | "failed";
  /** Why, when it was not `adapted`. Never a body or a field value. */
  reason?: string;
  /**
   * The refusal's or failure's id, as the caller was sent it in
   * `Invariant-Error-Id`, so what they quote can be found here.
   */
  errorId?: string;
}

/** Where a behaviour question is being asked from, for counting. */
export interface BehaviorContext {
  /** The contract this request is served under, from `resolve`. */
  contract: string;
  operation?: string | undefined;
  consumer?: string | undefined;
}

export interface RouteDecision {
  /** The path the canonical handler should see. */
  path: string;
  /** The method it should see, uppercase: the caller's own unless a route changed it. */
  method: string;
  /** What stage one could tell about the caller's contract, if anything. */
  hint: ContractResolution | undefined;
  rewritten: boolean;
}

/** The keys a response status is looked up by, most specific first, as OpenAPI orders them. */
function statusKeysFor(status: number): string[] {
  return [String(status), `${Math.floor(status / 100)}xx`, "default"];
}

export class InvariantRuntime {
  readonly #program: DecodedProgram;
  readonly #identity: readonly IdentityStrategy[];
  readonly #maxBodyBytes: number;
  readonly #limits: ExecuteLimits;
  readonly #fidelity: NumberFidelity;
  readonly #flags: () => RuntimeFlags;
  readonly #onUsage: ((event: UsageEvent) => void) | undefined;
  readonly #onOutcome: ((event: OutcomeEvent) => void) | undefined;
  readonly #behaviors: readonly string[];

  constructor(options: RuntimeOptions) {
    if (options.programDigest !== undefined) {
      const actual = programDigest(options.program);
      if (actual !== options.programDigest) {
        throw new ProgramError(
          `The program hashes to ${actual}, not the ${options.programDigest} ` +
            "invariant.lock records. It was changed after it was compiled; " +
            "compile it again from the reviewed Changes.",
        );
      }
    }
    this.#program = decodeProgram(options.program);
    this.#behaviors = [
      ...new Set(
        [...this.#program.contracts.values()].flatMap((contract) => contract.behaviors),
      ),
    ].sort();
    // Declared once, in `invariant.yaml`, and compiled into the program; a
    // binding's own list, where given, is for tests and migrations off it.
    const identity = options.identity ?? this.#program.identity;
    if (!identity) {
      throw new Error(
        "Nothing says how a request names its contract: declare `identity` in " +
          "invariant.yaml and compile again, or pass one to createRuntime.",
      );
    }
    this.#identity = identity;
    // A provider's own configuration naming a contract the program does not
    // have is a mistake to catch at startup, not on the first request that
    // happens to reach that branch.
    for (const strategy of this.#identity) {
      const named =
        strategy.kind === "default"
          ? [strategy.label]
          : strategy.kind === "urlPrefix"
            ? Object.values(strategy.map)
            : [];
      for (const label of named) {
        if (!this.knows(label)) {
          throw new Error(
            `The ${strategy.kind} identity strategy names contract "${label}", ` +
              `which this program does not have. Known: ${this.#knownLabels()}.`,
          );
        }
      }
    }
    this.#maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    // A provider who sets one limit keeps the defaults for the rest.
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#fidelity = options.numbers ?? "double";
    this.#flags = options.flags ?? (() => ({}));
    this.#onUsage = options.onUsage;
    this.#onOutcome = options.onOutcome;
  }

  get currentLabel(): string {
    return this.#program.currentLabel;
  }

  /** Largest body, in decoded bytes, a binding may buffer for a transform. */
  get maxBodyBytes(): number {
    return this.#maxBodyBytes;
  }

  get currentDigest(): string {
    return this.#program.current;
  }

  #knownList(): string[] {
    const labels = [this.#program.currentLabel, ...this.#program.contracts.keys()];
    return [...new Set(labels)].sort();
  }

  #knownLabels(): string {
    return this.#knownList().join(", ");
  }

  knows(label: string): boolean {
    return label === this.#program.currentLabel || this.#program.contracts.has(label);
  }

  /** Every behaviour flag any Change in this program declares. */
  get behaviors(): readonly string[] {
    return this.#behaviors;
  }

  /**
   * Whether this caller predates the change a behaviour flag marks.
   *
   * The escape hatch for everything the IR deliberately cannot express: a
   * change of side effect, of timing, of a business rule, or a reshaping no op
   * in the catalog covers. The provider writes the branch themselves, in their
   * own code, and this says which side of it a given caller belongs on.
   *
   *     if (inv.before("chg_capture_is_deferred", { contract })) {
   *       await captureImmediately(payment);
   *     }
   *
   * It is a fact about a public contract label and nothing else. It must never
   * decide what a caller is allowed to do: a label is chosen by the caller, so
   * branching authorisation on it would let anyone pick their own permissions.
   */
  before(flag: string, on: BehaviorContext): boolean {
    if (!this.#behaviors.includes(flag)) {
      throw new UnknownBehaviorError(flag, this.#behaviors);
    }

    // A caller on the current contract is by definition not before anything.
    const contract = this.#program.contracts.get(on.contract);
    if (!contract?.behaviors.includes(flag)) return false;

    // Counted the same way an applied op is, so a behaviour branch can be
    // retired on evidence rather than on a guess that nobody takes it any more.
    this.#onUsage?.({
      contract: on.contract,
      operation: on.operation ?? "behavior",
      consumer: on.consumer,
      changes: new Map([[flag, 1]]),
    });

    return true;
  }

  /**
   * Strips any inbound header in Invariant's internal namespace.
   *
   * Stage one tells stage two what it decided through such a header, so a
   * caller must never be able to supply one. A contract label only ever selects
   * a shape transform, but letting an outsider forge internal state is not a
   * property worth relying on.
   */
  static sanitizeHeaders(headers: Headers): void {
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith(INTERNAL_PREFIX)) headers.delete(name);
    }
  }

  /**
   * A caller refused before any operation is chosen, counted like every other
   * refusal and with the id they are sent, or a typo in a version header
   * would look like silence.
   */
  #refused(error: UnsupportedContractError, path: string): UnsupportedContractError {
    this.#onOutcome?.({
      contract: error.contract,
      operation: path,
      consumer: undefined,
      direction: "request",
      outcome: "refused",
      reason: "UnsupportedContractError",
      errorId: errorIdOf(error) as string,
    });
    return error;
  }

  /** Whatever the pre-authentication signals say about the caller's contract. */
  hintFrom(headers: Headers, path: string): ContractResolution | undefined {
    for (const strategy of this.#identity) {
      if (strategy.kind === "header") {
        const value = headers.get(strategy.name);
        if (value) {
          // A named contract that does not exist is refused, never ignored.
          // Ignoring it served the caller as current: a typo in a version
          // header, or a label for a contract since retired, got the newest
          // shape of every response with nothing to say why. That is the
          // breakage this product exists to prevent, arriving through its own
          // front door, and the design said to refuse it all along.
          if (!this.knows(value)) {
            throw this.#refused(
              UnsupportedContractError.unknown(value, this.#knownList()),
              path,
            );
          }
          return { label: value, source: "header" };
        }
      }
      if (strategy.kind === "urlPrefix") {
        for (const [prefix, label] of Object.entries(strategy.map)) {
          if (path.startsWith(prefix) && this.knows(label)) {
            return { label, source: "urlPrefix" };
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Stage one. Decides what path the canonical handler should see.
   *
   * When the caller declared a contract, that contract's route table is used.
   * When it did not, the path itself can still identify an old endpoint, but
   * only if every contract that knows it agrees on where it went; disagreement
   * is left alone rather than guessed at.
   */
  /**
   * A request's path as the contract writes it: the base path the API is
   * served under taken off. Undefined for a path outside it, which is not a
   * call to this API and is never touched.
   */
  #local(path: string): string | undefined {
    const base = this.#program.basePath;
    if (base === "") return path;
    if (path === base) return "/";
    return path.startsWith(`${base}/`) ? path.slice(base.length) : undefined;
  }

  /**
   * A request under a base path an older contract was served under, moved
   * under the current one. The version was in the server URL, so the base
   * path says which contract the caller was written against, when only one
   * contract used it.
   */
  #fromOlderBase(
    full: string,
    hint: ContractResolution | undefined,
  ): { path: string; hint: ContractResolution | undefined } | undefined {
    const current = this.#program.basePath;
    if (current !== "" && (full === current || full.startsWith(`${current}/`))) {
      return undefined;
    }
    let best: { base: string; labels: string[] } | undefined;
    for (const contract of this.#program.contracts.values()) {
      const base = contract.basePath;
      if (base === undefined || base === current) continue;
      if (hint && hint.label !== contract.label) continue;
      const under = base === "" || full === base || full.startsWith(`${base}/`);
      if (!under) continue;
      // The longest base that fits is the one the caller used.
      if (!best || base.length > best.base.length)
        best = { base, labels: [contract.label] };
      else if (base === best.base) best.labels.push(contract.label);
    }
    if (!best) return undefined;
    const rest = full.slice(best.base.length);
    const [only] = best.labels;
    return {
      path: `${current}${rest === "" ? "" : rest}` || "/",
      hint:
        hint ??
        (best.labels.length === 1 && only ? { label: only, source: "route" } : undefined),
    };
  }

  route(method: string, full: string, headers: Headers): RouteDecision {
    let hint = this.hintFrom(headers, full);
    const older = this.#fromOlderBase(full, hint);
    const moved = older !== undefined && older.path !== full;
    if (older) {
      full = older.path;
      hint = older.hint;
    }
    const path = this.#local(full);
    const asSent = method.toUpperCase();
    if (path === undefined) return { path: full, method: asSent, hint, rewritten: moved };

    const candidates: DecodedContract[] = hint
      ? [this.#program.contracts.get(hint.label)].filter(
          (contract): contract is DecodedContract => contract !== undefined,
        )
      : [...this.#program.contracts.values()];

    const matches = new Map<string, { label: string; method: string; path: string }>();
    for (const contract of candidates) {
      for (const rule of contract.routes) {
        if (rule.method !== method.toLowerCase()) continue;
        const params = matchTemplate(rule.from, path);
        if (!params) continue;
        const target = fillTemplate(rule.to, params);
        matches.set(`${rule.toMethod} ${target}`, {
          label: contract.label,
          method: rule.toMethod,
          path: target,
        });
      }
    }

    if (matches.size !== 1) {
      return { path: full, method: asSent, hint, rewritten: moved };
    }

    const [origin] = [...matches.values()] as [
      { label: string; method: string; path: string },
    ];
    const changedMethod = origin.method !== method.toLowerCase();
    return {
      path: `${this.#program.basePath}${origin.path}`,
      method: changedMethod ? origin.method.toUpperCase() : asSent,
      hint: hint ?? { label: origin.label, source: "route" },
      rewritten: moved || changedMethod || origin.path !== path,
    };
  }

  /** Stage two. Which contract this request is actually served under. */
  resolve(
    headers: Headers,
    path: string,
    pinned: string | undefined,
  ): ContractResolution {
    const hinted = headers.get(CONTRACT_HINT_HEADER);
    if (hinted && this.knows(hinted)) return { label: hinted, source: "header" };

    const direct = this.hintFrom(headers, path);
    if (direct) return direct;

    for (const strategy of this.#identity) {
      if (strategy.kind === "principal" && pinned !== undefined) {
        if (!this.knows(pinned)) {
          throw this.#refused(
            new UnsupportedContractError(
              pinned,
              "the account is pinned to an unknown contract",
            ),
            path,
          );
        }
        return { label: pinned, source: "principal" };
      }
      if (strategy.kind === "default") {
        return { label: strategy.label, source: "default" };
      }
    }

    return { label: this.#program.currentLabel, source: "default" };
  }

  /**
   * The compiled work for a request, or nothing at all.
   *
   * Returning nothing is the common case and the important one: a caller on the
   * current contract, or on an operation that never changed, costs a map lookup
   * and no body is read.
   */
  siteFor(
    label: string,
    method: string,
    path: string,
    context?: { operation?: string; consumer?: string | undefined },
  ): DecodedSite | undefined {
    try {
      // A HEAD is answered as its GET would be, headers and all, so it is
      // served by the GET's program.
      return this.#siteFor(label, method.toUpperCase() === "HEAD" ? "get" : method, path);
    } catch (error) {
      if (error instanceof UnsupportedContractError) {
        // A caller turned away entirely. Counted, because a kill switch left on
        // by accident looks like silence from exactly the consumers it is
        // refusing, and silence is what retirement reads as "nobody is left".
        this.#onOutcome?.({
          contract: label,
          operation: context?.operation ?? `${method.toLowerCase()} ${path}`,
          consumer: context?.consumer,
          direction: "request",
          outcome: "refused",
          reason: "UnsupportedContractError",
          errorId: errorIdOf(error) as string,
        });
      }
      throw error;
    }
  }

  #retiredIn(
    contract: DecodedContract,
    method: string,
    path: string,
  ): DecodedContract["retired"][number] | undefined {
    return contract.retired.find(
      (entry) =>
        entry.method === method.toLowerCase() &&
        matchTemplate(entry.path.split("/"), path) !== undefined,
    );
  }

  /**
   * An operation retired after this contract that is still passed on to the
   * provider, and what to tell the caller if the provider says it is gone.
   *
   * A binding forwards the call as usual and, when the answer is one of
   * `GONE_STATUSES`, replaces it with a 410 carrying this error's guidance.
   * The Change sets `refuse` when the provider's server no longer serves the
   * operation at all, and then the call never gets this far.
   * Anything else the provider answers goes back untouched: a specification
   * that dropped an operation its server still serves must not become an
   * outage the adapter caused.
   */
  retiredFor(
    label: string,
    method: string,
    full: string,
  ): RetiredEndpointError | undefined {
    if (label === this.#program.currentLabel) return undefined;
    const path = this.#local(full);
    const contract = this.#program.contracts.get(label);
    const gone =
      contract && path !== undefined && this.#retiredIn(contract, method, path);
    if (!gone || gone.refuse) return undefined;
    return new RetiredEndpointError(label, method, full, gone.c, gone.guidance);
  }

  #siteFor(label: string, method: string, full: string): DecodedSite | undefined {
    if (label === this.#program.currentLabel) return undefined;
    const path = this.#local(full);
    if (path === undefined) return undefined;

    const flags = this.#flags();
    const contract = this.#program.contracts.get(label);
    if (!contract) {
      throw new UnsupportedContractError(label, "no compiled program for this contract");
    }

    // Checked before the kill switch and before any site lookup: an endpoint
    // refused outright is gone whatever else is configured. One that is passed
    // on is answered by the binding once the provider has answered.
    const gone = this.#retiredIn(contract, method, path);
    if (gone?.refuse) {
      throw new RetiredEndpointError(label, method, full, gone.c, gone.guidance);
    }
    if (flags.allDisabled) {
      throw new UnsupportedContractError(label, "compatibility is switched off");
    }
    if (flags.disabledContracts?.includes(label)) {
      throw new UnsupportedContractError(label, "this contract is switched off");
    }

    const site = findSite(contract, method, path);
    if (!site) return undefined;

    const disabled = flags.disabledChanges;
    if (disabled && disabled.length > 0) {
      const referenced = new Set<string>();
      changesIn(site.request, referenced);
      changesIn(site.envelope?.instrs ?? [], referenced);
      for (const list of site.response.values()) changesIn(list, referenced);
      for (const rule of site.status) referenced.add(rule.c);
      for (const change of disabled) {
        if (referenced.has(change)) {
          // Skipping a switched-off instruction would hand back a body in the
          // wrong shape, which is worse than refusing the request.
          throw new UnsupportedContractError(label, `change ${change} is switched off`);
        }
      }
    }

    return site;
  }

  #run(
    instrs: readonly CompiledInstr[],
    numeric: boolean,
    text: string,
    context: { contract: string; operation: string; consumer: string | undefined },
  ): Transformed {
    if (instrs.length === 0) return { body: text, folded: [] };
    if (text.length > this.#maxBodyBytes) throw new BodyTooLargeError(this.#maxBodyBytes);

    const parsed = parseJson(text, numeric ? this.#fidelity : "double");
    const result = execute(parsed, instrs, this.#limits);

    if (this.#onUsage && result.applied.size > 0) {
      this.#onUsage({
        contract: context.contract,
        operation: context.operation,
        consumer: context.consumer,
        changes: result.applied,
      });
    }

    return { body: stringifyJson(parsed), folded: [...result.folded].sort() };
  }

  /**
   * A form-encoded request body rewritten by the site's program: the fields
   * it names decoded, transformed and written back, and every other pair of
   * the form passed on exactly as it came.
   */
  transformRequestForm(
    site: DecodedSite,
    text: string,
    context: { contract: string; operation: string; consumer?: string | undefined },
  ): string {
    const form = site.form;
    if (!form || site.request.length === 0) return text;
    return this.#reporting("request", context, () => {
      if (text.length > this.#maxBodyBytes)
        throw new BodyTooLargeError(this.#maxBodyBytes);
      const roots = formRoots(site.request, 0);
      const tree = openForm(form, roots, text, site.numeric ? this.#fidelity : "double");
      this.#counted(execute(tree, site.request, this.#limits), context);
      return closeForm(form, roots, text, tree, site.request, 0);
    });
  }

  /**
   * An XML request body rewritten by the site's program: the places it names
   * decoded, transformed and written back, and every element it does not
   * name passed on exactly as it came.
   */
  transformRequestXml(
    site: DecodedSite,
    text: string,
    context: { contract: string; operation: string; consumer?: string | undefined },
    contentType?: string | null,
  ): string {
    const body = site.xml?.request;
    if (!body || site.request.length === 0) return text;
    return this.#reporting("request", context, () =>
      this.#runXml(site.request, body, site.numeric, text, context, contentType),
    ).body;
  }

  #runXml(
    instrs: readonly CompiledInstr[],
    body: XmlBody,
    numeric: boolean,
    text: string,
    context: { contract: string; operation: string; consumer?: string | undefined },
    contentType: string | null | undefined,
  ): Transformed {
    if (instrs.length === 0) return { body: text, folded: [] };
    if (text.length > this.#maxBodyBytes) throw new BodyTooLargeError(this.#maxBodyBytes);
    const opened = openXml(body, text, numeric ? this.#fidelity : "double", contentType);
    const result = execute(opened.tree, instrs, this.#limits);
    this.#counted(result, context);
    return {
      body: closeXml(opened, body.write, instrs, 0),
      folded: [...result.folded].sort(),
    };
  }

  /**
   * Whether an answer with this status and type is one the site adapts the
   * body of: JSON, or XML where the site describes the body it answered with.
   * A binding that holds a response back to adapt it holds one this names.
   */
  adaptsResponseBody(
    site: DecodedSite | undefined,
    status: number,
    contentType: string | null | undefined,
  ): boolean {
    if (site === undefined || !this.respondsTo(site, status)) return false;
    if (isJsonMediaType(contentType)) return true;
    return isXmlMediaType(contentType) && this.xmlResponseFor(site, status) !== undefined;
  }

  /** The description of the body the provider answered `status` with, where it may be XML. */
  xmlResponseFor(site: DecodedSite, status: number): XmlBody | undefined {
    const key = statusKeysFor(status).find((each) => site.response.has(each));
    return key === undefined ? undefined : site.xml?.response.get(key);
  }

  #counted(
    result: ReturnType<typeof execute>,
    context: { contract: string; operation: string; consumer?: string | undefined },
  ): void {
    if (this.#onUsage && result.applied.size > 0) {
      this.#onUsage({
        contract: context.contract,
        operation: context.operation,
        consumer: context.consumer,
        changes: result.applied,
      });
    }
  }

  transformRequest(
    site: DecodedSite,
    text: string,
    context: { contract: string; operation: string; consumer?: string | undefined },
  ): string {
    return this.#reporting("request", context, () =>
      this.#run(site.request, site.numeric, text, {
        contract: context.contract,
        operation: context.operation,
        consumer: context.consumer,
      }),
    ).body;
  }

  /** True when adapting this request means reading its body. */
  readsRequestBody(site: DecodedSite): boolean {
    return site.request.length > 0 || site.envelope?.body === true;
  }

  /** True when some program converts a path parameter, so the path itself can change. */
  get rewritesPathParameters(): boolean {
    for (const contract of this.#program.contracts.values()) {
      for (const site of contract.sites.values()) {
        if (
          site.envelope?.instrs.some((instr) => pathsOfInstr(instr)[0]?.[0] === "@path")
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * The request headers a caller sent, as the handler should compare them,
   * on a site whose answers are adapted for an older contract: tags this
   * runtime marked for the caller's contract are unmarked, so a conditional
   * request can still be answered `304`, and tags it did not mark, which name
   * another contract's bytes, are made unable to match.
   */
  conditionalHeaders(
    headers: Headers,
    contract: string,
    site: DecodedSite | undefined,
  ): Headers {
    return contract === this.currentLabel || !site
      ? headers
      : unmarkConditionals(headers, contract);
  }

  /**
   * What the provider declared about this contract's end, told to its callers
   * on every answer: `Deprecation` (RFC 9745), a date as a structured-field
   * item, and `Sunset` (RFC 8594), an HTTP date. A caller reading its own
   * responses learns when its contract stops being served without reading a
   * changelog. A header the provider's own code already set is left as it is.
   */
  #markRetirement(headers: Headers, label: string): void {
    const contract = this.#program.contracts.get(label);
    if (!contract) return;
    if (contract.deprecated !== undefined && !headers.has("deprecation")) {
      const at = Date.parse(contract.deprecated);
      if (!Number.isNaN(at)) headers.set("deprecation", `@${Math.floor(at / 1000)}`);
    }
    if (contract.sunset !== undefined && !headers.has("sunset")) {
      const at = new Date(contract.sunset);
      if (!Number.isNaN(at.getTime())) headers.set("sunset", at.toUTCString());
    }
  }

  /** The request headers that choose a contract, which every response varies on. */
  get varyOn(): readonly string[] {
    return this.#identity.flatMap((strategy) =>
      strategy.kind === "header" ? [strategy.name] : [],
    );
  }

  /**
   * The handler's response as the caller's contract describes it: the one
   * place every binding adapts a response, so they cannot disagree about it.
   *
   * Every response varies on the header that chose its contract, current
   * callers' included, since a cache keyed on the URL alone would hand one
   * contract's shape to another's callers, and one served under an older
   * contract names it. A body is
   * read only where the site has work for its status and it is JSON, or XML
   * the site describes; anything else passes through as a stream. An adapted body's entity tag
   * is marked with the contract, and so is a `304`'s or a `HEAD`'s for a
   * site whose bodies are adapted, whose length is dropped because it
   * describes bytes the caller is never sent. A body that cannot be
   * expressed becomes the provider's error, never the untranslated body.
   */
  async adaptResponse(
    site: DecodedSite | undefined,
    response: Response,
    context: { contract: string; operation: string; consumer?: string | undefined },
    options: {
      /** Whether the body bytes are still encoded, as they are in-process. */
      encoded: boolean;
      /** The request's method, so a `HEAD` is answered as its `GET` would be. */
      method?: string;
      errors?: ErrorShaper;
    },
  ): Promise<Response> {
    const headers = new Headers(response.headers);
    const adapted = context.contract !== this.currentLabel;
    // A current caller's answer is left as it was, but for `Vary`: a cache
    // holding it must not hand it to a caller who named an older contract.
    if (adapted) headers.set(CONTRACT_RESPONSE_HEADER, context.contract);
    if (adapted) this.#markRetirement(headers, context.contract);
    appendVary(headers, this.varyOn);
    const mark = (into: Headers) => {
      const etag = into.get("etag");
      if (etag === null) return;
      const marked = markEtag(etag, context.contract);
      if (marked === undefined) into.delete("etag");
      else into.set("etag", marked);
    };

    // The status the caller's contract promised for this answer, where a
    // Change moved it; the work for the body is still the provider's status's.
    const answered = adapted ? this.statusFor(site, response.status) : undefined;
    const shown = answered?.status ?? response.status;
    if (answered) this.#countStatus(answered, context);

    // A 304 stands for the 200 it revalidates; a HEAD for the GET it mirrors.
    const head = options.method?.toUpperCase() === "HEAD";
    const stands = response.status === 304 ? 200 : response.status;
    if (
      adapted &&
      site &&
      (head || response.status === 304) &&
      (this.respondsTo(site, stands) || answered !== undefined)
    ) {
      if (answered?.empty) withoutBody(headers);
      else mark(headers);
      if (head) headers.delete("content-length");
      return new Response(null, { status: head ? shown : response.status, headers });
    }
    if (answered?.empty) {
      // The caller's contract promised no body with this status, so whatever
      // the provider sent with its own is not sent on. Its entity tag names
      // the resource rather than these bytes, and is left as it came.
      await response.body?.cancel();
      withoutBody(headers);
      if (!EMPTY_STATUSES.has(shown)) headers.set("content-length", "0");
      return new Response(null, { status: shown, headers });
    }
    const contentType = response.headers.get("content-type");
    // An XML body is read where the site describes the one it answered with;
    // anything else it holds no description for passes through as it came.
    const xml =
      site !== undefined &&
      !isJsonMediaType(contentType) &&
      isXmlMediaType(contentType) &&
      this.xmlResponseFor(site, response.status) !== undefined;
    if (
      !site ||
      !response.body ||
      !this.respondsTo(site, response.status) ||
      !(xml || isJsonMediaType(contentType))
    ) {
      return responseOf(response.body, shown, headers);
    }

    try {
      const original = await readBodyText(response, {
        limit: this.#maxBodyBytes,
        encoded: options.encoded,
      });
      const transformed = xml
        ? this.transformResponseXml(
            site,
            response.status,
            original.text,
            context,
            contentType,
          )
        : this.transformResponseDetailed(site, response.status, original.text, context);
      const rebuilt = headersForText(headers, transformed.body, original.decoded);
      if (transformed.body !== original.text) mark(rebuilt);
      if (transformed.folded.length > 0) {
        // Only when a fold fired. The caller was shown a value their contract
        // names in place of one it does not, and this is how they can know.
        rebuilt.set(FOLDED_HEADER, transformed.folded.join(", "));
      }
      return responseOf(transformed.body, shown, rebuilt);
    } catch (error) {
      const shaped = responseFailure(options.errors ?? DEFAULT_ERROR_SHAPER, error);
      if (!shaped) throw error;
      const failed = new Headers({
        "content-type": "application/json",
        [CONTRACT_RESPONSE_HEADER]: context.contract,
      });
      if (shaped.errorId !== undefined) failed.set(ERROR_ID_HEADER, shaped.errorId);
      appendVary(failed, this.varyOn);
      return new Response(JSON.stringify(shaped.body), {
        status: shaped.status,
        headers: failed,
      });
    }
  }

  /**
   * An incoming request as the provider's handler should see it: the one
   * place every binding adapts a request, so they cannot disagree about it.
   *
   * `parts` is the path, query string and headers as the binding would pass
   * them on, after routing and after its own header hygiene. Only a JSON body,
   * or a form or XML one the site describes, is ever read, and only when the
   * site's program reaches into it. Anything
   * else a program would have to write a body into is refused rather than
   * replaced, because a form or an upload rewritten as JSON is a request the
   * provider never agreed to receive.
   */
  async adaptRequest(
    site: DecodedSite,
    request: Request,
    parts: { path: string; search: string; headers: Headers },
    context: { contract: string; operation: string; consumer?: string | undefined },
  ): Promise<AdaptedRequest> {
    const unchanged: AdaptedRequest = { ...parts, body: request.body };
    const contentType = request.headers.get("content-type");
    const json = isJsonMediaType(contentType);
    // A form is something a program describes only where the operation
    // declares one; anywhere else it is passed on as it came.
    const form = !json && isFormMediaType(contentType) && site.form !== undefined;
    // XML likewise, where the operation declares its request body as XML.
    const xml =
      !json && !form && isXmlMediaType(contentType) && site.xml?.request !== undefined;

    if (!site.envelope) {
      if (site.request.length === 0 || !request.body || !(json || form || xml)) {
        return unchanged;
      }
      const original = await readBodyText(request, {
        limit: this.#maxBodyBytes,
        encoded: true,
      });
      const body = form
        ? this.transformRequestForm(site, original.text, context)
        : xml
          ? this.transformRequestXml(site, original.text, context, contentType)
          : this.transformRequest(site, original.text, context);
      return {
        ...parts,
        headers: headersForText(parts.headers, body, original.decoded),
        body,
      };
    }

    const envelope = site.envelope;
    if (envelope.body && request.body && !json && !form && !xml) {
      throw new TransformError(
        envelope.instrs.find((instr) =>
          pathsOfInstr(instr).some((path) => path[0] === "@body"),
        )?.c ?? "",
        "This operation's program writes into the request body, and the body sent is not JSON.",
      );
    }
    const original =
      envelope.body && request.body
        ? await readBodyText(request, { limit: this.#maxBodyBytes, encoded: true })
        : undefined;
    const result = this.transformEnvelope(
      site,
      {
        path: parts.path,
        search: parts.search.startsWith("?") ? parts.search.slice(1) : parts.search,
        headers: [...parts.headers],
        body: original?.text,
        ...(form ? { form: true } : {}),
        ...(xml ? { xml: true } : {}),
      },
      context,
    );
    let headers = new Headers(result.headers);
    let body: ReadableStream<Uint8Array> | string | null = request.body;
    if (original !== undefined && result.body !== undefined) {
      body = result.body;
      headers = headersForText(headers, body, original.decoded);
    } else if (original === undefined && result.body !== undefined) {
      // A body the program built from parameters, where the caller sent none.
      body = result.body;
      headers.set("content-type", "application/json");
      headers = headersForText(headers, body, false);
    }
    return {
      path: result.path,
      search: result.search === "" ? "" : `?${result.search}`,
      headers,
      body,
    };
  }

  /**
   * The whole request rewritten, for an operation where a Change reaches a
   * parameter: its path, query string, headers and, where the program reads
   * it, its body.
   *
   * `request.path` is the routed path as the caller's URL has it, base path
   * included. Nothing outside what the program names is changed, down to the
   * bytes and order of an untouched query string.
   */
  transformEnvelope(
    site: DecodedSite,
    request: EnvelopeRequest,
    context: { contract: string; operation: string; consumer?: string | undefined },
  ): EnvelopeRequest {
    const envelope = site.envelope;
    const local = this.#local(request.path);
    if (!envelope || envelope.instrs.length === 0 || local === undefined) return request;
    return this.#reporting("request", context, () => {
      if (request.body !== undefined && request.body.length > this.#maxBodyBytes) {
        throw new BodyTooLargeError(this.#maxBodyBytes);
      }
      const values = matchTemplate(site.template, local) ?? [];
      const fidelity = site.numeric ? this.#fidelity : "double";
      const opened = { ...request, path: local };
      const form = request.form === true && envelope.body ? site.form : undefined;
      const xml = request.xml === true && envelope.body ? site.xml?.request : undefined;
      if (xml) {
        // An XML body is decoded and written back by its description; the
        // rest of the envelope is what it always is.
        const parameters = { ...envelope, body: false };
        const text = request.body ?? "";
        const contentType = request.headers.find(
          ([name]) => name.toLowerCase() === "content-type",
        )?.[1];
        const tree = openEnvelope(parameters, site.template, values, opened, fidelity);
        const decoded = openXml(xml, text, fidelity, contentType);
        tree["@body"] = decoded.tree;
        this.#counted(execute(tree, envelope.instrs, this.#limits), context);
        const closed = closeEnvelope(parameters, site.template, values, opened, tree);
        if (tree["@body"] !== decoded.tree) {
          throw new TransformError(
            envelope.instrs[0]?.c ?? "",
            "The program replaced the whole XML body, which has nowhere to be written back.",
          );
        }
        return {
          ...closed,
          path: `${this.#program.basePath}${closed.path}`,
          body: closeXml(decoded, xml.write, envelope.instrs, 1),
        };
      }
      if (!form) {
        const tree = openEnvelope(envelope, site.template, values, opened, fidelity);
        this.#counted(execute(tree, envelope.instrs, this.#limits), context);
        const closed = closeEnvelope(envelope, site.template, values, opened, tree);
        return { ...closed, path: `${this.#program.basePath}${closed.path}` };
      }
      // A form body is decoded and written back by the form rules; the rest
      // of the envelope is what it always is.
      const parameters = { ...envelope, body: false };
      const roots = formRoots(envelope.instrs, 1);
      const text = request.body ?? "";
      const tree = openEnvelope(parameters, site.template, values, opened, fidelity);
      tree["@body"] = openForm(form, roots, text, fidelity);
      this.#counted(execute(tree, envelope.instrs, this.#limits), context);
      const closed = closeEnvelope(parameters, site.template, values, opened, tree);
      const body = tree["@body"];
      return {
        ...closed,
        path: `${this.#program.basePath}${closed.path}`,
        body: closeForm(
          form,
          roots,
          text,
          (typeof body === "object" && body !== null ? body : {}) as Record<string, Json>,
          envelope.instrs,
          1,
        ),
      };
    });
  }

  transformResponse(
    site: DecodedSite,
    status: number,
    text: string,
    context: { contract: string; operation: string; consumer?: string | undefined },
  ): string {
    return this.transformResponseDetailed(site, status, text, context).body;
  }

  /**
   * The transformed body, and where a value was folded to get it.
   *
   * A fold is the one transform that shows a caller something untrue: the API
   * produced a value their contract never named, and they are shown one it
   * does. They have no way to notice. Returning where it happened lets whoever
   * writes the response say so, which is the difference between a mitigation a
   * caller can reason about and one that quietly misleads them.
   */
  transformResponseDetailed(
    site: DecodedSite,
    status: number,
    text: string,
    context: { contract: string; operation: string; consumer?: string | undefined },
  ): Transformed {
    const instrs = statusKeysFor(status)
      .map((key) => site.response.get(key))
      .find((found) => found !== undefined);
    if (!instrs) return { body: text, folded: [] };

    return this.#reporting("response", context, () =>
      this.#run(instrs, site.numeric, text, {
        contract: context.contract,
        operation: context.operation,
        consumer: context.consumer,
      }),
    );
  }

  /**
   * An XML response body in the caller's shape, and where a value was folded
   * to get it: as `transformResponseDetailed`, over the XML the site
   * describes for the status.
   */
  transformResponseXml(
    site: DecodedSite,
    status: number,
    text: string,
    context: { contract: string; operation: string; consumer?: string | undefined },
    contentType?: string | null,
  ): Transformed {
    const key = statusKeysFor(status).find((each) => site.response.has(each));
    const instrs = key === undefined ? undefined : site.response.get(key);
    const body = key === undefined ? undefined : site.xml?.response.get(key);
    if (!instrs || !body) return { body: text, folded: [] };
    return this.#reporting("response", context, () =>
      this.#runXml(instrs, body, site.numeric, text, context, contentType),
    );
  }

  /**
   * A payload the provider sends of its own accord, a webhook or a callback,
   * in the shape a subscriber on `contract` expects.
   *
   * `event` names it as the contract does: `webhook:<name>` for an entry
   * under `webhooks`, `callback:<operation>/<callback>` for one under an
   * operation's `callbacks`. Adapt before signing. A subscriber verifies the
   * signature over the bytes it receives, so a payload signed and then
   * adapted fails verification for every old subscriber at once.
   *
   * A subscriber on the current contract, or an event nothing changed, gets
   * the payload as it is. A contract that is switched off, or a Change in the
   * event's program that is, refuses rather than send a payload in a shape
   * the subscriber was never promised.
   */
  adaptOutbound(
    contract: string,
    event: string,
    text: string,
    options: { method?: string; consumer?: string } = {},
  ): Transformed {
    if (contract === this.#program.currentLabel) return { body: text, folded: [] };
    const program = this.#program.contracts.get(contract);
    if (!program) {
      throw new UnsupportedContractError(
        contract,
        "no compiled program for this contract",
      );
    }
    const flags = this.#flags();
    if (flags.allDisabled) {
      throw new UnsupportedContractError(contract, "compatibility is switched off");
    }
    if (flags.disabledContracts?.includes(contract)) {
      throw new UnsupportedContractError(contract, "this contract is switched off");
    }
    const method = (options.method ?? "post").toLowerCase();
    const found = program.outbound.get(`${method} ${event}`);
    if (!found) return { body: text, folded: [] };
    const referenced = changesIn(found.instrs, new Set());
    for (const change of flags.disabledChanges ?? []) {
      if (referenced.has(change)) {
        throw new UnsupportedContractError(contract, `change ${change} is switched off`);
      }
    }
    const context = { contract, operation: event, consumer: options.consumer };
    return this.#reporting("outbound", context, () =>
      this.#run(found.instrs, found.numeric, text, context),
    );
  }

  /**
   * Runs a transform and reports how it ended.
   *
   * Reported here rather than in each framework binding, so a provider gets
   * the same evidence whatever they mounted the runtime in, and so a binding
   * cannot forget. A failure on the way in refused the request and nothing
   * happened; a failure on the way out means the operation already ran and
   * somebody is getting an error for work that succeeded, which is the number
   * that actually matters.
   */
  #reporting<T>(
    direction: "request" | "response" | "outbound",
    context: { contract: string; operation: string; consumer?: string | undefined },
    run: () => T,
  ): T {
    if (!this.#onOutcome) return run();

    const base = {
      contract: context.contract,
      operation: context.operation,
      consumer: context.consumer,
      direction,
    };
    try {
      const result = run();
      this.#onOutcome({ ...base, outcome: "adapted" });
      return result;
    } catch (error) {
      const errorId = errorIdOf(error);
      this.#onOutcome({
        ...base,
        outcome: direction === "request" ? "refused" : "failed",
        reason: error instanceof Error ? error.name : "Error",
        ...(errorId === undefined ? {} : { errorId }),
      });
      throw error;
    }
  }

  /**
   * The status an old caller is answered with where the provider answered
   * `status`, whether it goes without a body, and the Changes that said so:
   * the site's rules applied in turn. Nothing where no rule names the status.
   * A binding that holds a response back to adapt it holds one this names,
   * whatever its body.
   */
  statusFor(
    site: DecodedSite | undefined,
    status: number,
  ): { status: number; empty: boolean; changes: string[] } | undefined {
    if (!site || site.status.length === 0) return undefined;
    let current = status;
    let empty = false;
    const changes: string[] = [];
    for (const rule of site.status) {
      if (rule.from !== current) continue;
      current = rule.to;
      empty ||= rule.empty;
      changes.push(rule.c);
    }
    if (changes.length === 0) return undefined;
    return { status: current, empty: empty || EMPTY_STATUSES.has(current), changes };
  }

  /** A status answered as another, counted as any applied Change is. */
  #countStatus(
    answered: { changes: string[] },
    context: { contract: string; operation: string; consumer?: string | undefined },
  ): void {
    this.#onUsage?.({
      contract: context.contract,
      operation: context.operation,
      consumer: context.consumer,
      changes: new Map(answered.changes.map((change) => [change, 1])),
    });
  }

  /** True when this status has compiled response work, so the body must be read. */
  respondsTo(site: DecodedSite, status: number): boolean {
    return statusKeysFor(status).some((key) => (site.response.get(key)?.length ?? 0) > 0);
  }
}

export function createRuntime(options: RuntimeOptions): InvariantRuntime {
  return new InvariantRuntime(options);
}
