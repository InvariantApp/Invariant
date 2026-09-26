// The SDK imported whole, its type named through the namespace.
import * as acme from "acme";

const client = new acme.Acme("sk_test");

export async function nameOf(id: string): Promise<string> {
  const customer: acme.Customer = await client.customers.retrieve(id);
  return customer.nickname;
}
