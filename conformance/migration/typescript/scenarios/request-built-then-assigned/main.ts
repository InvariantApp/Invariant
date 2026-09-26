// A request built empty with the SDK's parameter type, the renamed field
// assigned afterwards.
import Acme, { type CustomerCreateParams } from "acme";

const client = new Acme("sk_test");

export function signUp(email: string, name?: string) {
  const params: CustomerCreateParams = { email };
  if (name) {
    params.nickname = name;
  }
  return client.customers.create(params);
}
