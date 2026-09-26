// The consumer's own type has a field of the same name.
import Acme from "acme";

const client = new Acme("sk_test");

interface Profile {
  nickname: string;
}

export function greet(profile: Profile): string {
  return profile.nickname;
}

export async function profileOf(id: string): Promise<Profile> {
  const customer = await client.customers.retrieve(id);
  return { nickname: customer.id };
}
