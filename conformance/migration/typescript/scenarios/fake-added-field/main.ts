// A test's stand-in for a response, cast to the SDK's type, lacking a
// field the response now has.
import type { Customer } from "acme";

export const customer = { id: "cus_1", object: "customer" } as Customer; // <- flag
