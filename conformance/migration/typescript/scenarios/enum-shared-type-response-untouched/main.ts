// The response's status shares the request's value type, and only the
// request's values were renamed.
import type { Customer } from "acme";

export function isLive(customer: Customer): boolean {
  return customer.status === "active";
}
