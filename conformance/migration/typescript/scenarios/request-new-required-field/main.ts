// A request that lacks a field which became required, with the value it
// always had when left out.
import Acme from "acme";

const client = new Acme("sk_test");

export function signUp(email: string, name: string) {
  return client.customers.create({ email, nickname: name });
}
