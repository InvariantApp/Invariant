// The request body's field is renamed; the response's field of the same
// name is not, and is what this reads.
import Acme from "acme";

const client = new Acme("sk_test");

export async function nameOf(id: string): Promise<string> {
  const customer = await client.customers.retrieve(id);
  return customer.nickname;
}
