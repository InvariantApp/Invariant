// The objects the API sends and takes, named the way a hand-written SDK
// such as stripe-node names them: a type per schema, the wire's own names as
// its properties.

export type CustomerStatus = "active" | "inactive";

export interface Address {
  line1: string;
  line2: string | null;
  postal_code: string;
  city: string;
}

export interface Card {
  id: string;
  brand: string;
  last4: string;
  fingerprint: string;
}

/** What every object about a person carries. */
export interface CustomerBase {
  id: string;
  email: string;
}

export interface Customer extends CustomerBase {
  object: "customer";
  nickname: string;
  fax: string | null;
  /** Seconds since the epoch. */
  created: number;
  status: CustomerStatus;
  /** In major units. */
  balance: number;
  phone: string;
  address: Address;
  cards: Card[];
}

export interface CustomerCreateParams {
  email?: string;
  nickname?: string;
  fax?: string;
  status?: CustomerStatus;
  balance?: number;
  phone?: string;
  address?: Address;
}

export interface Merchant {
  id: string;
  nickname: string;
}
