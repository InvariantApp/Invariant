import type Pay from "paysdk";

/** The consumer's handler for a subscription the SDK hands it. */
export function couponCode(subscription: Pay.Subscription): string | undefined {
  return subscription.items[0]?.id;
}
