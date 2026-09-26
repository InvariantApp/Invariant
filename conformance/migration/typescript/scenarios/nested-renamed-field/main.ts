// A renamed field of a nested object, read through the response.
import type { Customer } from "acme";

export function zipOf(customer: Customer): string {
  return customer.address.postal_code;
}
