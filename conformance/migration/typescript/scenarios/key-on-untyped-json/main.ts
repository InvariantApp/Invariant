// The renamed field read by key from a webhook payload parsed as untyped JSON.
import Acme from "acme";

const client = new Acme("sk_test");

export async function onEvent(body: string): Promise<string> {
  const event = JSON.parse(body);
  await client.customers.retrieve(event.data.object["id"]);
  return event.data.object["nickname"]; // <- flag
}
