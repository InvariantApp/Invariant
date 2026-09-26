// A renamed field of a list item, read by index.
import type { Customer } from "acme";

export function firstDigits(customer: Customer): string {
  return customer.cards[0].last4;
}
