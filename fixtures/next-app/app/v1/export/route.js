// The suite's `csv` handler: a body the program does not describe.
export const dynamic = "force-dynamic";

export function GET() {
  return new Response("id,amount\np_1,1999\n", {
    headers: { "content-type": "text/csv" },
  });
}
