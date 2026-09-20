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
import {
  type CompiledInstr,
  DEFAULT_LIMITS,
  type ExecuteLimits,
  execute,
  TransformError,
} from "./interpreter.ts";
import { type NumberFidelity, parseJson, stringifyJson } from "./json.ts";
import {
  type DecodedContract,
  type DecodedProgram,
  type DecodedSite,
  decodeProgram,
  fillTemplate,
  findSite,
  matchTemplate,
  ProgramError,
} from "./program.ts";

export type { DecodedProgram, DecodedSite };
export { decodeProgram, ProgramError, TransformError };

/** Header stage one uses to tell stage two what it concluded. */
export const CONTRACT_HINT_HEADER = "x-invariant-contract-hint";
export const CONTRACT_RESPONSE_HEADER = "invariant-contract";
const INTERNAL_PREFIX = "x-invariant-";

export type IdentityStrategy =
  | { kind: "header"; name: string }
  | { kind: "urlPrefix"; map: Record<string, string> }
  | { kind: "principal" }
  | { kind: "default"; label: string };

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
  identity: readonly IdentityStrategy[];
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

export class UnsupportedContractError extends Error {
  readonly contract: string;

  constructor(contract: string, reason: string) {
    super(`Contract ${contract} cannot be served right now: ${reason}`);
    this.name = "UnsupportedContractError";
    this.contract = contract;
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

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds the ${limit} byte limit for a transformed operation`);
    this.name = "BodyTooLargeError";
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
  direction: "request" | "response";
  /**
   * `adapted`: the body was rewritten and the caller got their own shape.
   * `refused`: the request never reached the handler, so nothing happened.
   * `failed`: the operation ran and its result could not be expressed in the
   * caller's contract, which is the one that costs somebody something.
   */
  outcome: "adapted" | "refused" | "failed";
  /** Why, when it was not `adapted`. Never a body or a field value. */
  reason?: string;
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
  /** What stage one could tell about the caller's contract, if anything. */
  hint: ContractResolution | undefined;
  rewritten: boolean;
}

function statusKeysFor(status: number): string[] {
  return [String(status), `${Math.floor(status / 100)}xx`];
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
    this.#program = decodeProgram(options.program);
    this.#behaviors = [
      ...new Set(
        [...this.#program.contracts.values()].flatMap((contract) => contract.behaviors),
      ),
    ].sort();
    this.#identity = options.identity;
    this.#maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.#limits = options.limits ?? DEFAULT_LIMITS;
    this.#fidelity = options.numbers ?? "double";
    this.#flags = options.flags ?? (() => ({}));
    this.#onUsage = options.onUsage;
    this.#onOutcome = options.onOutcome;
  }

  get currentLabel(): string {
    return this.#program.currentLabel;
  }

  get currentDigest(): string {
    return this.#program.current;
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

  /** Whatever the pre-authentication signals say about the caller's contract. */
  hintFrom(headers: Headers, path: string): ContractResolution | undefined {
    for (const strategy of this.#identity) {
      if (strategy.kind === "header") {
        const value = headers.get(strategy.name);
        if (value && this.knows(value)) return { label: value, source: "header" };
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
  route(method: string, path: string, headers: Headers): RouteDecision {
    const hint = this.hintFrom(headers, path);

    const candidates: DecodedContract[] = hint
      ? [this.#program.contracts.get(hint.label)].filter(
          (contract): contract is DecodedContract => contract !== undefined,
        )
      : [...this.#program.contracts.values()];

    const matches = new Map<string, { label: string }>();
    for (const contract of candidates) {
      for (const rule of contract.routes) {
        if (rule.method !== method.toLowerCase()) continue;
        const params = matchTemplate(rule.from, path);
        if (!params) continue;
        matches.set(fillTemplate(rule.to, params), { label: contract.label });
      }
    }

    if (matches.size !== 1) {
      return { path, hint, rewritten: false };
    }

    const [target, origin] = [...matches.entries()][0] as [string, { label: string }];
    return {
      path: target,
      hint: hint ?? { label: origin.label, source: "route" },
      rewritten: target !== path,
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
          throw new UnsupportedContractError(
            pinned,
            "the account is pinned to an unknown contract",
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
      return this.#siteFor(label, method, path);
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
        });
      }
      throw error;
    }
  }

  #siteFor(label: string, method: string, path: string): DecodedSite | undefined {
    if (label === this.#program.currentLabel) return undefined;

    const flags = this.#flags();
    const contract = this.#program.contracts.get(label);
    if (!contract) {
      throw new UnsupportedContractError(label, "no compiled program for this contract");
    }

    // Checked before the kill switch and before any site lookup: a retired
    // endpoint is gone whatever else is configured, and saying so is more
    // useful than any of the other answers available here.
    const gone = contract.retired.find(
      (entry) =>
        entry.method === method.toLowerCase() &&
        matchTemplate(entry.path.split("/"), path) !== undefined,
    );
    if (gone) {
      throw new RetiredEndpointError(label, method, path, gone.c, gone.guidance);
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
      for (const instr of site.request) referenced.add(instr.c);
      for (const list of site.response.values()) {
        for (const instr of list) referenced.add(instr.c);
      }
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
  ): string {
    if (instrs.length === 0) return text;
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

    return stringifyJson(parsed);
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
    );
  }

  transformResponse(
    site: DecodedSite,
    status: number,
    text: string,
    context: { contract: string; operation: string; consumer?: string | undefined },
  ): string {
    const instrs = statusKeysFor(status)
      .map((key) => site.response.get(key))
      .find((found) => found !== undefined);
    if (!instrs) return text;

    return this.#reporting("response", context, () =>
      this.#run(instrs, site.numeric, text, {
        contract: context.contract,
        operation: context.operation,
        consumer: context.consumer,
      }),
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
  #reporting(
    direction: "request" | "response",
    context: { contract: string; operation: string; consumer?: string | undefined },
    run: () => string,
  ): string {
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
      this.#onOutcome({
        ...base,
        outcome: direction === "request" ? "refused" : "failed",
        reason: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
  }

  /** True when this status has compiled response work, so the body must be read. */
  respondsTo(site: DecodedSite, status: number): boolean {
    return statusKeysFor(status).some((key) => (site.response.get(key)?.length ?? 0) > 0);
  }
}

export function createRuntime(options: RuntimeOptions): InvariantRuntime {
  return new InvariantRuntime(options);
}
