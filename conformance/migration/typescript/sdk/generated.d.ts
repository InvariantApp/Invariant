// Types generated from the contract by openapi-typescript: one interface
// holding every schema, reached by indexing, and nothing else.
export interface components {
  schemas: {
    address: {
      line1: string;
      line2: string | null;
      postal_code: string;
      city: string;
    };
    card: {
      id: string;
      brand: string;
      last4: string;
      fingerprint: string;
    };
    customer: {
      id: string;
      email: string;
      object: "customer";
      nickname: string;
      fax: string | null;
      created: number;
      /** @enum {string} */
      status: "active" | "inactive";
      balance: number;
      phone: string;
      address: components["schemas"]["address"];
      cards: components["schemas"]["card"][];
    };
    customer_create_params: {
      email?: string;
      nickname?: string;
      fax?: string;
      /** @enum {string} */
      status?: "active" | "inactive";
      balance?: number;
      phone?: string;
      address?: components["schemas"]["address"];
    };
  };
}
