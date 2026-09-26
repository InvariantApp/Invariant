// A renamed request field, written inline in the SDK's call.
import Acme from "acme";

const client = new Acme("sk_test");

export function signUp(email: string, name: string) {
  return client.customers.create({ email, nickname: name });
}
