// A field the response's list items lost.
import type { Customer } from "acme";

export function fingerprints(customer: Customer): string[] {
  return customer.cards.map((card) => card.fingerprint); // <- flag
}
