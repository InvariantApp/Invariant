// The renamed field read with a fallback from untyped JSON.
import Acme from "acme";

const client = new Acme("sk_test");

export async function onEvent(body: string): Promise<string> {
  const event = JSON.parse(body);
  await client.customers.retrieve(event.data.object.id);
  const { nickname = "friend" } = event.data.object; // <- flag
  return nickname;
}
