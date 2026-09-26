// The renamed field read by a string key from the SDK's object.
import type { Customer } from "acme";

export function nameOf(customer: Customer): string {
  return customer["nickname"];
}
