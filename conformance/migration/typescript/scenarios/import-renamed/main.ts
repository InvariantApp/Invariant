// The SDK's client and type imported under other names.
import { type Customer as Account, Acme as Api } from "acme";

const api = new Api("sk_test");

export function label(account: Account): string {
  return account.nickname;
}

export async function show(id: string): Promise<string> {
  return label(await api.customers.retrieve(id));
}
