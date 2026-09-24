import { couponCode } from "./handler.js";

// A test of the handler that never imports the SDK: its stand-in is only
// what the test needs, and the mismatch with the SDK's type is silenced.
export function checksTheHandler(): void {
  const subscription = { id: "sub_1", discount: { coupon: "HALF" } };
  // @ts-expect-error the stand-in leaves out what the test does not need
  couponCode(subscription);

  // The consumer's own record, never handed to the SDK's type.
  const row = { discount: 10 };
  console.log(row);
}
