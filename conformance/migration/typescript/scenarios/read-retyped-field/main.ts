// A field that is now RFC 3339 text, read and used as epoch seconds.
import Acme from "acme";

const client = new Acme("sk_test");

export async function ageInDays(id: string, now: number): Promise<number> {
  const customer = await client.customers.retrieve(id);
  return (now - customer.created) / 86400; // <- flag
}
