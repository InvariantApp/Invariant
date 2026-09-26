// A response object's removed field, read directly.
import Acme from "acme";

const client = new Acme("sk_test");

export async function faxOf(id: string): Promise<string | null> {
  const customer = await client.customers.retrieve(id);
  return customer.fax; // <- flag
}
