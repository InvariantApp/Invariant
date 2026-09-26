// An amount now in minor units, destructured into a local of the same name
// that must keep meaning major units.
import Acme from "acme";

const client = new Acme("sk_test");

export async function owed(id: string): Promise<number> {
  const { balance, email } = await client.customers.retrieve(id);
  return email === "" ? 0 : balance;
}
