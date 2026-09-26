import type { DiffEntry } from "@invariant-app/diff";
import { describe, expect, it } from "vitest";
import { breakingNames, forcedBy, namesWritten, normalName } from "./forced.mts";

const entry = (id: string, text: string, level = 3, path = "/v1/charges"): DiffEntry => ({
  id,
  text,
  level,
  operation: "POST",
  operationId: "",
  path,
  section: "paths",
  fingerprint: "",
});

describe("breakingNames", () => {
  it("takes the elements breaking entries quote, and nothing else", () => {
    const names = breakingNames([
      entry(
        "response-property-removed",
        "removed the optional property `data/items/amount_refunded` from the response with the `200` status",
      ),
      entry(
        "response-body-one-of-added",
        "added `#/components/schemas/PaymentIntent` to the `content/items/` response property `oneOf` list",
      ),
      // Not breaking: an INFO entry names nothing forced.
      entry("response-property-added", "added the property `refunds`", 1),
    ]);
    expect(names).toEqual(["amountrefunded", "paymentintent"]);
  });

  it("names an operation's path only when the operation went away", () => {
    expect(
      breakingNames([entry("api-removed-without-deprecation", "api removed")]),
    ).toEqual(["charges"]);
    expect(
      breakingNames([
        entry("request-parameter-removed", "removed the `expand` parameter"),
      ]),
    ).toEqual(["expand"]);
  });
});

describe("forcedBy", () => {
  const names = new Set(["amountrefunded", "paymentintent"].map(normalName));

  it("finds a broken name however the language spells it", () => {
    expect(forcedBy(['charge["amount_refunded"] = 0'], names)).toBe("amount_refunded");
    expect(forcedBy(["total := charge.AmountRefunded"], names)).toBe("AmountRefunded");
    expect(forcedBy(["const intent: PaymentIntent = x"], names)).toBe("PaymentIntent");
  });

  it("calls a site that names nothing broken a choice", () => {
    expect(forcedBy(["tools = [code_execution_20260120]"], names)).toBeUndefined();
  });
});

describe("namesWritten", () => {
  it("reads names where an API element can be written", () => {
    expect(namesWritten('charge["amount_refunded"] = 0')).toEqual(["amount_refunded"]);
    expect(namesWritten("total := charge.AmountRefunded")).toEqual(["AmountRefunded"]);
    expect(namesWritten("stripe.PaymentIntent.create(amount=100, expand=x)")).toEqual([
      "PaymentIntent",
      "create",
      "amount",
      "expand",
    ]);
    expect(namesWritten("    automatic_payment_methods={")).toEqual([
      "automatic_payment_methods",
    ]);
    expect(namesWritten("  amountRefunded: 0,")).toEqual(["amountRefunded"]);
  });

  it("leaves out the consumer's own variables", () => {
    expect(namesWritten('messages.append({"role": "tool", "content": result})')).toEqual([
      "role",
      "tool",
      "content",
      "append",
    ]);
    expect(namesWritten("result = compute(output)")).toEqual([]);
  });
});

describe("forcedBy, on what a site writes", () => {
  it("does not take a variable, a keyword or a common word for a broken element", () => {
    const names = new Set(["result", "none"]);
    expect(forcedBy(['"content": result', "x = None"], names)).toBeUndefined();
  });
});

describe("breakingNames, with ambiguous names", () => {
  it("drops a name too many schemas declare to say which one broke", () => {
    const removed = (name: string): DiffEntry =>
      entry("response-property-removed", `removed the property \`data/${name}\``);
    expect(
      breakingNames([removed("type"), removed("function_call")], new Set(["type"])),
    ).toEqual(["functioncall"]);
  });
});
