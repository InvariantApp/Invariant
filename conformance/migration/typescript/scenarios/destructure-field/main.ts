// The renamed field bound to a local of the same name by destructuring.
import Acme from "acme";

const client = new Acme("sk_test");

export async function contact(id: string): Promise<string[]> {
  const { nickname, email } = await client.customers.retrieve(id);
  return [nickname, email];
}
