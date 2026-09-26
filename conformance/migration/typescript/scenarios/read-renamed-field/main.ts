// A response object's renamed field, read directly.
import Acme from "acme";

const client = new Acme("sk_test");

export async function nameOf(id: string): Promise<string> {
  const customer = await client.customers.retrieve(id);
  return customer.nickname;
}
