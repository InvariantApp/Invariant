// The consumer's own wrapper over the SDK, handed a callback that reads the
// renamed field.
import Acme, { type Customer } from "acme";

const client = new Acme("sk_test");

async function withCustomer<T>(id: string, read: (customer: Customer) => T): Promise<T> {
  return read(await client.customers.retrieve(id));
}

export function nameOf(id: string): Promise<string> {
  return withCustomer(id, (customer) => customer.nickname);
}
