// A recorded webhook, kept as the untyped JSON the API sent, which names
// its own schema.
import type { Customer } from "acme";

export function handle(event: { data: { object: Customer } }): string {
  return event.data.object.id;
}

export const recorded = {
  type: "customer.updated",
  data: {
    object: {
      object: "customer",
      id: "cus_1",
      nickname: "Ada", // <- flag
    },
  },
};
