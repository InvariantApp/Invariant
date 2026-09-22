import type Pay from "paysdk";

// A stand-in for a response, as a consumer's tests build one.
export const fakeSubscription: Pay.Subscription = {
  id: "sub_1",
  discount: null,
  automatic_tax: { enabled: true },
  items: [],
};
