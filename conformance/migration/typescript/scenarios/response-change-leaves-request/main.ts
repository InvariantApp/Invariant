// The response's field is renamed; the request body's field of the same
// name is not, and is what this writes.
import Acme from "acme";

const client = new Acme("sk_test");

export function signUp(email: string, name: string) {
  return client.customers.create({ email, nickname: name });
}
