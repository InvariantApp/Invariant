// A renamed field of a list item, read in a loop.
import type { Customer } from "acme";

export function digits(customer: Customer): string[] {
  const found: string[] = [];
  for (const card of customer.cards) {
    found.push(card.last4);
  }
  return found;
}
