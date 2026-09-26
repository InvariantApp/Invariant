// A renamed request field written through a generated request type.
import type { components } from "acme/generated";

type CreateCustomer = components["schemas"]["customer_create_params"];

export function signUpBody(email: string, name: string): CreateCustomer {
  return { email, nickname: name };
}
