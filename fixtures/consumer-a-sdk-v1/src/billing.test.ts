import { AcmeClient } from "@acme/sdk-v1";
import { describe, expect, it } from "vitest";
import {
  chargeProrated,
  chargeSubscription,
  chargeWithOverrides,
  describeCharge,
  refundFully,
  totalBilled,
} from "./billing.ts";
import { connectAcme } from "./support.ts";

function client(): AcmeClient {
  return new AcmeClient(connectAcme());
}

describe("consumer A on contract 2026-01-15", () => {
  it("bills a subscription at the plan price in major units", async () => {
    const receipt = await chargeSubscription(client(), "growth", "tok_visa");
    expect(receipt.billed).toBe(49.99);
    expect(receipt.currency).toBe("usd");
    expect(receipt.settled).toBe(true);
    expect(receipt.chargeId).toMatch(/^pay_/);
  });

  it("marks a declined charge as unsettled", async () => {
    const receipt = await chargeSubscription(client(), "starter", "tok_fail");
    expect(receipt.billed).toBe(9.99);
    expect(receipt.settled).toBe(false);
  });

  it("charges a prorated amount computed at runtime", async () => {
    const charge = await chargeProrated(client(), "growth", 15, "tok_visa");
    expect(charge.amount).toBe(25);
    expect(charge.object).toBe("charge");
  });

  it("charges through a spread of create params", async () => {
    const charge = await chargeWithOverrides(
      client(),
      { amount: 12.5, currency: "usd", source: "tok_visa" },
      { description: "override" },
    );
    expect(charge.amount).toBe(12.5);
    expect(charge.description).toBe("override");
  });

  it("refunds the full charge amount", async () => {
    const acme = client();
    const receipt = await chargeSubscription(acme, "scale", "tok_visa");
    const charge = await acme.charges.retrieve(receipt.chargeId);
    const refund = await refundFully(acme, charge);
    expect(refund.charge).toBe(charge.id);
    expect(refund.amount).toBe(249);
  });

  it("totals only settled charges", async () => {
    const acme = client();
    const settled = await chargeSubscription(acme, "starter", "tok_visa");
    const declined = await chargeSubscription(acme, "growth", "tok_fail");
    const charges = await Promise.all([
      acme.charges.retrieve(settled.chargeId),
      acme.charges.retrieve(declined.chargeId),
    ]);
    expect(totalBilled(charges)).toBe(9.99);
  });

  it("lists recent charges", async () => {
    const acme = client();
    const receipt = await chargeSubscription(acme, "starter", "tok_visa");
    const list = await acme.charges.list({ limit: 10 });
    expect(list.object).toBe("list");
    expect(list.data.map((charge) => charge.id)).toContain(receipt.chargeId);
  });

  it("formats a charge for a receipt line", async () => {
    const acme = client();
    const receipt = await chargeSubscription(acme, "growth", "tok_visa");
    const charge = await acme.charges.retrieve(receipt.chargeId);
    expect(describeCharge(charge)).toBe(`${charge.id}: 49.99 USD (succeeded)`);
  });
});
