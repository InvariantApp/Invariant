import { describe, expect, it } from "vitest";
import {
  campaignProgress,
  donate,
  lookupDonation,
  refundDonation,
  suggestedAmounts,
} from "./donations.ts";
import { connectAcme } from "./support.ts";

describe("consumer C on contract 2026-03-01", () => {
  it("offers suggested amounts in major units", () => {
    expect(suggestedAmounts()).toEqual([5, 25, 100]);
  });

  it("records a donation at the requested amount", async () => {
    const result = await donate(connectAcme(), 25, "tok_visa", "Annual fund");
    expect(result.amount).toBe(25);
    expect(result.currency).toBe("usd");
    expect(result.status).toBe("succeeded");
    expect(result.acknowledged).toBe(true);
  });

  it("handles a declined donation", async () => {
    const result = await donate(connectAcme(), 5, "tok_fail");
    expect(result.acknowledged).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("raises a donation error on a rejected amount", async () => {
    await expect(donate(connectAcme(), 0, "tok_visa")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("looks a donation up again", async () => {
    const config = connectAcme();
    const created = await donate(config, 100, "tok_visa");
    const found = await lookupDonation(config, created.id);
    expect(found?.amount).toBe(100);
    expect(await lookupDonation(config, "pay_missing")).toBeNull();
  });

  it("refunds a donation in full", async () => {
    const config = connectAcme();
    const created = await donate(config, 25, "tok_visa");
    const refund = await refundDonation(config, created.id);
    expect(refund.amount).toBe(25);
  });

  it("reports campaign progress from acknowledged donations", async () => {
    const config = connectAcme();
    const first = await donate(config, 100, "tok_visa");
    const declined = await donate(config, 100, "tok_fail");
    expect(campaignProgress([first, declined], 400)).toEqual({
      raised: 100,
      percent: 25,
    });
  });
});
