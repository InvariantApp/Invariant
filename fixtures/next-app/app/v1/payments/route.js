// The suite's `create` handler: answers with what it was sent.
export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await request.json();
  return Response.json(
    {
      seen: body,
      amount_cents: body.amount_cents ?? body.amount,
      status: body.status ?? "succeeded",
    },
    { status: 201 },
  );
}
