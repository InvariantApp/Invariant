// A renamed field assigned on an SDK object the consumer holds.
import Acme, { type Customer } from "acme";

const client = new Acme("sk_test");

export async function rename(id: string, name: string): Promise<Customer> {
  const customer = await client.customers.retrieve(id);
  customer.nickname = name;
  return customer;
}
