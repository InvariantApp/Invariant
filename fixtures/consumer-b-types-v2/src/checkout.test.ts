import { describe, expect, it } from "vitest";
import {
  fetchPayment,
  invoiceTotal,
  payInvoice,
  paySetupFee,
  receiptLine,
  refundPayment,
  settledRevenue,
} from "./checkout.ts";
import { connectAcme } from "./support.ts";

const ITEMS = [
  { sku: "seat", unitPrice: 12.5, quantity: 3 },
  { sku: "addon", unitPrice: 4.99, quantity: 1 },
];

describe("consumer B on contract 2026-03-01", () => {
  it("totals an invoice without float drift", () => {
    expect(invoiceTotal(ITEMS)).toBe(42.49);
  });

  it("pays an invoice for the computed major-unit total", async () => {
    const payment = await payInvoice(connectAcme(), ITEMS, "tok_visa");
    expect(payment.amount).toBe(42.49);
    expect(payment.object).toBe("payment");
    expect(payment.payment_method.token).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
  });

  it("pays a literal setup fee", async () => {
    const payment = await paySetupFee(connectAcme(), "tok_visa");
    expect(payment.amount).toBe(199);
    expect(payment.description).toBe("One-time setup fee");
  });

  it("reports a declined payment", async () => {
    const payment = await payInvoice(connectAcme(), ITEMS, "tok_fail");
    expect(payment.status).toBe("failed");
  });

  it("surfaces the offending parameter on a validation error", async () => {
    const client = connectAcme();
    await expect(
      payInvoice(client, [{ sku: "free", unitPrice: 0, quantity: 1 }], "tok_visa"),
    ).rejects.toMatchObject({ status: 400, param: "amount" });
  });

  it("retrieves and refunds a payment", async () => {
    const client = connectAcme();
    const payment = await payInvoice(client, ITEMS, "tok_visa");
    const fetched = await fetchPayment(client, payment.id);
    expect(fetched?.amount).toBe(42.49);

    const refund = await refundPayment(client, payment);
    expect(refund.payment).toBe(payment.id);
    expect(refund.amount).toBe(42.49);
  });

  it("sums settled revenue and formats receipt lines", async () => {
    const client = connectAcme();
    const paid = await payInvoice(client, ITEMS, "tok_visa");
    const declined = await payInvoice(client, ITEMS, "tok_fail");
    expect(settledRevenue([paid, declined])).toBe(42.49);
    expect(receiptLine(paid)).toBe(`${paid.id} 42.49 usd succeeded`);
  });

  it("returns null for a missing payment", async () => {
    expect(await fetchPayment(connectAcme(), "pay_missing")).toBeNull();
  });
});
