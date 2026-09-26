// A renamed enum value sent in a request.
import Acme from "acme";

const client = new Acme("sk_test");

export function signUp(email: string) {
  return client.customers.create({ email, status: "active" });
}
