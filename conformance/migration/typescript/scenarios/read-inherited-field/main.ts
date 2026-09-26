// A renamed field the SDK declares on the base its response type extends.
import Acme from "acme";

const client = new Acme("sk_test");

export async function emailOf(id: string): Promise<string> {
  const customer = await client.customers.retrieve(id);
  return customer.email;
}
