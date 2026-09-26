// Another of the SDK's types, which no Change touches, has a field of the
// same name.
import Acme from "acme";

const client = new Acme("sk_test");

export async function merchantName(id: string): Promise<string> {
  const merchant = await client.merchants.retrieve(id);
  return merchant.nickname;
}
