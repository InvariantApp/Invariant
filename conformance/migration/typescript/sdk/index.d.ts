// The SDK's entry point, re-exporting the types its resources declare, as
// stripe-node and most hand-written SDKs do.
import type { Customer, CustomerCreateParams, Merchant } from "./resources/customers";

export type {
  Address,
  Card,
  Customer,
  CustomerBase,
  CustomerCreateParams,
  CustomerStatus,
  Merchant,
} from "./resources/customers";

export declare class CustomersResource {
  retrieve(id: string): Promise<Customer>;
  create(params: CustomerCreateParams): Promise<Customer>;
  list(): Promise<{ data: Customer[] }>;
}

export declare class MerchantsResource {
  retrieve(id: string): Promise<Merchant>;
}

export declare class Acme {
  constructor(apiKey: string);
  customers: CustomersResource;
  merchants: MerchantsResource;
}

/** Exact conversions between an amount in major units and in minor units. */
export declare function toMinorUnits(amount: number): number;
export declare function fromMinorUnits(minor: number): number;

export default Acme;
