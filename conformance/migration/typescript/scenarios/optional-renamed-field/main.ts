// The renamed field read from a response that may be absent.
import type { Customer } from "acme";

export function label(customer: Customer | undefined): string | undefined {
  return customer?.nickname;
}
