// The consumer's own function returns the response; the field is read off
// the call.
import Acme, { type Customer } from "acme";

const client = new Acme("sk_test");

function load(id: string): Promise<Customer> {
  return client.customers.retrieve(id);
}

export async function nameOf(id: string): Promise<string> {
  return (await load(id)).nickname;
}
