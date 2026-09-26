// The response copied to another local, the renamed field read through it.
import Acme from "acme";

const client = new Acme("sk_test");

export async function nameOf(id: string): Promise<string> {
  const customer = await client.customers.retrieve(id);
  const current = customer;
  return current.nickname;
}
