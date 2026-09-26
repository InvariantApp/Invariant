// An amount now in minor units, read where the SDK exports an exact conversion.
import Acme from "acme";

const client = new Acme("sk_test");

export async function owed(id: string): Promise<number> {
  const customer = await client.customers.retrieve(id);
  return customer.balance;
}
