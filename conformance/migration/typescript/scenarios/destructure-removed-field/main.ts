// A removed field bound to a local by destructuring.
import type { Customer } from "acme";

export function reachable(customer: Customer): string[] {
  const { fax, email } = customer; // <- flag
  return fax === null ? [email] : [email, fax];
}
