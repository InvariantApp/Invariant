// The suite's `read` handler: a tagged answer, and 304 when the tag matches.
export const dynamic = "force-dynamic";

export function GET(request) {
  if (request.headers.get("if-none-match") === '"v7"') {
    return new Response(null, { status: 304, headers: { etag: '"v7"' } });
  }
  return Response.json({ id: "p_1", amount_cents: 1999 }, { headers: { etag: '"v7"' } });
}
