// A request field the API no longer accepts.
import Acme from "acme";

const client = new Acme("sk_test");

export function signUp(email: string, faxNumber: string) {
  return client.customers.create({
    email,
    fax: faxNumber, // <- flag
  });
}
