// A copy of the response with the renamed field overridden.
import type { Customer } from "acme";

export function renamed(customer: Customer, name: string): Customer {
  return { ...customer, nickname: name };
}
