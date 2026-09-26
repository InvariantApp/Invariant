// A renamed enum value compared with the response's field.
import type { Customer } from "acme";

export function isLive(customer: Customer): boolean {
  return customer.status === "active";
}
