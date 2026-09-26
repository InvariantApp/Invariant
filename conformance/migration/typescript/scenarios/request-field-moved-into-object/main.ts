// A request field now sent inside a nested object.
import Acme from "acme";

const client = new Acme("sk_test");

export function signUp(email: string, mobile: string) {
  return client.customers.create({ email, phone: mobile });
}
