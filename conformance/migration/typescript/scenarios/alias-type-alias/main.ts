// The SDK's type named through the consumer's own alias.
import type { Customer } from "acme";

type Account = Customer;

export function label(account: Account): string {
  return account.nickname;
}
