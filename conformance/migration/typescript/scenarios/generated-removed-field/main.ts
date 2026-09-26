// A removed field read through types openapi-typescript generated.
import type { components } from "acme/generated";

type Customer = components["schemas"]["customer"];

export function faxOf(customer: Customer): string | null {
  return customer.fax; // <- flag
}
