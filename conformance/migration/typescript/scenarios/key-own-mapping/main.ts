// The consumer's own typed mapping has an entry with the field's name.
import Acme from "acme";

const client = new Acme("sk_test");

const labels: Record<string, string> = { nickname: "Nickname", email: "Email" };

export async function heading(id: string): Promise<string> {
  const customer = await client.customers.retrieve(id);
  return [labels["nickname"], customer.id].join(": ");
}
