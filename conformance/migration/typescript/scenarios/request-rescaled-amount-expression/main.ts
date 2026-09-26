// A request amount now sent in minor units, written as a computed value.
import Acme from "acme";

const client = new Acme("sk_test");

export function signUp(email: string, credit: number) {
  return client.customers.create({ email, balance: credit * 2 });
}
