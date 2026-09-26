// A renamed enum value as a case of a switch over the response's field.
import type { Customer } from "acme";

export function badge(customer: Customer): string {
  switch (customer.status) {
    case "active":
      return "Live";
    case "inactive":
      return "Paused";
  }
}
