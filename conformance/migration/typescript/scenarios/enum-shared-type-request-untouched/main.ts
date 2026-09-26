// The request's status shares the response's value type, and only the
// response's values were renamed.
import Acme from "acme";

const client = new Acme("sk_test");

export function signUp(email: string) {
  return client.customers.create({ email, status: "active" });
}
