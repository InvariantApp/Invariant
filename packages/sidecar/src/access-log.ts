/**
 * One JSON line per request, for a provider whose log pipeline expects the
 * proxy to say what it served.
 *
 * Never a body, a query string or a header value: those carry what callers
 * send, and an access log is read by more people than the API is. The path is
 * kept, as every access log keeps it, and the contract the answer was shaped
 * for is named so a spike in one contract's errors is visible at a glance.
 * `ms` is the time until the answer began, not until its last byte, since a
 * streamed body is written after the handler has returned.
 */
import type { FetchHandler } from "./proxy.ts";

export function accessLogged(
  handler: FetchHandler,
  write: (line: string) => void,
  now: () => number = () => performance.now(),
): FetchHandler {
  return async (request) => {
    const started = now();
    const url = new URL(request.url);
    const line = (status: number, contract: string | null, errorId: string | null) =>
      write(
        JSON.stringify({
          at: new Date().toISOString(),
          method: request.method,
          path: url.pathname,
          status,
          ms: Math.round((now() - started) * 10) / 10,
          ...(contract ? { contract } : {}),
          ...(errorId ? { errorId } : {}),
        }),
      );
    try {
      const response = await handler(request);
      line(
        response.status,
        response.headers.get("invariant-contract"),
        response.headers.get("invariant-error-id"),
      );
      return response;
    } catch (error) {
      line(500, null, null);
      throw error;
    }
  };
}
