// An amount now in minor units, read from a response that may be absent.
import type { Customer } from "acme";

export function owed(customer: Customer | undefined): number | undefined {
  return customer?.balance; // <- flag
}
