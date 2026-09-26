// A field the response's nested object lost.
import type { Customer } from "acme";

export function secondLine(customer: Customer): string | null {
  return customer.address.line2; // <- flag
}
