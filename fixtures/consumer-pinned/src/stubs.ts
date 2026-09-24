import type Pay from "paysdk";

/** A test's stand-in for a subscription, handed to a mock that takes anything. */
export function stubbed(mock: { resolves(value: unknown): void }): void {
  mock.resolves({ id: "sub_1", discount: { coupon: "HALF" } });
}

/** A webhook's payload, read as it arrived. */
// biome-ignore lint/suspicious/noExplicitAny: a payload read as it arrived
export function couponIn(payload: any): string | undefined {
  return payload.discount?.coupon ?? payload["discount"]?.coupon;
}

/** The consumer's own record, which has a discount of its own. */
interface Row {
  discount: number;
}

export const row: Row = { discount: 10 };

export type Client = Pay;
