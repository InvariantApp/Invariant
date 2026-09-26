// The consumer's own type has a status compared with the old value's
// spelling.
import type { Customer } from "acme";

interface Order {
  status: string;
  customer: Customer;
}

export function open(order: Order): boolean {
  return order.status === "active" && order.customer.id !== "";
}
