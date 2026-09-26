// The field handed to the consumer's own helper, typed with the SDK's
// values, which compares it with a renamed value.
import type { Customer, CustomerStatus } from "acme";

function isLive(status: CustomerStatus): boolean {
  return status === "active";
}

export function live(customer: Customer): boolean {
  return isLive(customer.status);
}
