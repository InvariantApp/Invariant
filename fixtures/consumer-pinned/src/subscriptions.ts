import Pay from "paysdk";

const pay = new Pay("sk_test");

export async function couponOf(id: string): Promise<string | undefined> {
  const subscription = await pay.subscriptions.retrieve(id);
  return subscription.discount?.coupon;
}

export async function renewsAt(id: string): Promise<number | undefined> {
  const subscription = await pay.subscriptions.retrieve(id);
  return subscription.items[0]?.current_period_end;
}
