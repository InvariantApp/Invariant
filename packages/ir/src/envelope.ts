/**
 * The request envelope: every part of a request a Change can address, as one
 * tree.
 *
 * Instructions address it with a first segment naming the part:
 * `/@path/id`, `/@query/limit`, `/@header/x-page-size`, `/@cookie/session_hint`
 * and `/@body/...`. The same six instructions work in every part, so a
 * parameter that moves from the query string into the body is one `move`, and
 * a query parameter renamed in the same release as a body field is two
 * instructions in one ordered list rather than two programs whose order
 * nobody wrote down.
 */

export const PARAMETER_LOCATIONS = ["path", "query", "header", "cookie"] as const;
export type ParameterLocation = (typeof PARAMETER_LOCATIONS)[number];

/** The first segment of an envelope pointer, for each part of a request. */
export const ENVELOPE_PARTS = {
  path: "@path",
  query: "@query",
  header: "@header",
  cookie: "@cookie",
  body: "@body",
} as const;

/**
 * Headers no Change may read or write.
 *
 * Credentials, because a program that can move a credential can move it
 * somewhere it is logged. Hop-by-hop and framing headers, because they
 * describe the connection and the bytes rather than the request, and the
 * binding rewrites them itself. The cookie header, because cookies are
 * addressed one by one under `@cookie`. Anything that signs or digests the
 * message, because a request rewritten under a signature is a request whose
 * signature no longer verifies, and quietly failing verification is the worst
 * way to find that out.
 */
export const DENIED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
  "content-type",
  "content-encoding",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

/** Header names that sign, digest or authenticate a message, by their wording. */
const DENIED_WORDS = /signature|hmac|digest|credential|secret/;

/** Whether a header, compared case-insensitively, may never be addressed. */
export function isDeniedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_HEADERS.has(lower) || DENIED_WORDS.test(lower);
}
