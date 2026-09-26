// The renamed field destructured into a local of another name.
import type { Customer } from "acme";

export function zipOf(customer: Customer): string[] {
  const { postal_code: zip, city } = customer.address;
  return [zip, city];
}
