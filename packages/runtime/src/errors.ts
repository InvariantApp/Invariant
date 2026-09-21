/**
 * How a refusal is reported to a caller, in the provider's own error shape.
 *
 * Shared by every binding, because the rules for what a caller is told are
 * part of the product rather than part of any one framework. When they lived
 * in the Hono binding alone, a second binding would have needed its own copy,
 * and two copies of "what does a caller hear when their contract is retired"
 * is how the two drift until one of them answers 500.
 */
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
} as const;
