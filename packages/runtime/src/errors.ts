/**
 * How a refusal is reported to a caller, in the provider's own error shape.
 *
 * Shared by every binding, because the rules for what a caller is told are
 * part of the product rather than part of any one framework. When they lived
 * in the Hono binding alone, a second binding would have needed its own copy,
 * and two copies of "what does a caller hear when their contract is retired"
 * is how the two drift until one of them answers 500.
 */
import { MatchLimitError, TransformError } from "./interpreter.ts";

export interface ShapedError {
  body: unknown;
  status: number;
}

export interface ErrorShaper {
  /** Something about the request itself. Nothing has run yet. */
  badRequest: (message: string, code: string) => ShapedError;
  /** The operation ran and its answer could not be expressed. */
  serverError: (message: string, code: string) => ShapedError;
  /**
   * An operation the caller's contract had and the current one does not.
   * Optional so a shaper written before it existed keeps working.
   */
  gone?: (message: string, code: string) => ShapedError;
}

const shaped = (type: string, status: number) => (message: string, code: string) => ({
  body: { error: { type, message, code } },
  status,
});

export const DEFAULT_ERROR_SHAPER: Required<ErrorShaper> = {
  badRequest: shaped("invalid_request_error", 400),
  serverError: shaped("api_error", 502),
  gone: shaped("invalid_request_error", 410),
};

/** The shaper's `gone`, or the default's when it has none. */
export function goneWith(
  errors: ErrorShaper,
): (message: string, code: string) => ShapedError {
  return errors.gone ?? DEFAULT_ERROR_SHAPER.gone;
}

/** Codes a caller or an operator can search for. Stable once published. */
export const ERROR_CODES = {
  contractUnsupported: "invariant_contract_unsupported",
  endpointRetired: "invariant_endpoint_retired",
  bodyTooLarge: "invariant_body_too_large",
  requestNotTranslatable: "invariant_request_not_translatable",
  responseNotTranslatable: "invariant_response_not_translatable",
  upstreamUnavailable: "invariant_upstream_unavailable",
  encodingUnsupported: "invariant_encoding_unsupported",
} as const;

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds the ${limit} byte limit for a transformed operation`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * A body nested deeper than this runtime will walk.
 *
 * Refused before anything parses it: every step that reads a body, parsing it,
 * transforming it and writing it back, follows its nesting, and a request made
 * of fifty thousand brackets would otherwise exhaust the stack and answer 500.
 * Treated as too large, which is what it is.
 */
export class BodyTooDeepError extends BodyTooLargeError {
  readonly depth: number;

  constructor(depth: number) {
    super(0);
    this.message = `The body is nested more than ${depth} levels deep, which is deeper than a transformed operation accepts.`;
    this.name = "BodyTooDeepError";
    this.depth = depth;
  }
}

/** A `Content-Encoding` this runtime has no way to decode. */
export class UnsupportedEncodingError extends Error {
  readonly encoding: string;

  constructor(encoding: string) {
    super(
      `The body is encoded as "${encoding}", which cannot be decoded here, so it ` +
        "cannot be translated.",
    );
    this.name = "UnsupportedEncodingError";
    this.encoding = encoding;
  }
}

/**
 * What a caller is told when their request could not be translated.
 *
 * Nothing has reached the provider's handler, so refusing has no side effect.
 * Returns undefined for anything that is not a translation failure, which the
 * binding must let propagate: an unrelated bug is not a caller's fault and
 * must not be dressed up as one.
 */
export function requestFailure(
  errors: ErrorShaper,
  error: unknown,
): ShapedError | undefined {
  // Too much of it, whether by bytes or by how many places one instruction
  // reaches. Either way the request is too large to translate.
  if (error instanceof BodyTooLargeError || error instanceof MatchLimitError) {
    return { ...errors.badRequest(error.message, ERROR_CODES.bodyTooLarge), status: 413 };
  }
  if (error instanceof UnsupportedEncodingError) {
    return {
      ...errors.badRequest(error.message, ERROR_CODES.encodingUnsupported),
      status: 415,
    };
  }
  if (error instanceof TransformError || error instanceof SyntaxError) {
    return errors.badRequest(error.message, ERROR_CODES.requestNotTranslatable);
  }
  return undefined;
}

/**
 * What a caller is told when the answer could not be translated back.
 *
 * The operation already ran. What must not happen now is handing back a body
 * shaped for a contract the caller does not speak, and that includes a body
 * the provider sent that was not valid JSON at all.
 */
export function responseFailure(
  errors: ErrorShaper,
  error: unknown,
): ShapedError | undefined {
  if (
    error instanceof TransformError ||
    error instanceof BodyTooLargeError ||
    error instanceof UnsupportedEncodingError ||
    error instanceof SyntaxError
  ) {
    return errors.serverError(
      "The response could not be expressed in the contract this integration uses.",
      ERROR_CODES.responseNotTranslatable,
    );
  }
  return undefined;
}
