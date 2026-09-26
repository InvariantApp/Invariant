// A removed field checked for null before use.
import type { Customer } from "acme";

export function faxOf(customer: Customer): string {
  return customer.fax !== null ? customer.fax : ""; // <- flag
}
