import { describe, expect, it } from "vitest";
import { classFields, withFields } from "./stubs.mts";

const spec = {
  openapi: "3.0.0",
  info: { title: "t", version: "2022-11-15" },
  paths: {},
  components: {
    schemas: {
      subscription: {
        properties: {
          id: { type: "string" },
          current_period_end: { type: "integer" },
          cancel_at: { type: "integer", nullable: true },
          customer: {
            anyOf: [
              { type: "string", maxLength: 5000 },
              { $ref: "#/components/schemas/customer" },
            ],
          },
          items: { $ref: "#/components/schemas/subscription_item_list" },
          default_tax_rates: {
            type: "array",
            items: { $ref: "#/components/schemas/tax_rate" },
          },
          automatic_tax: { $ref: "#/components/schemas/subscription_automatic_tax" },
        },
      },
      customer: { properties: { email: { type: "string", nullable: true } } },
      subscription_automatic_tax: { properties: { enabled: { type: "boolean" } } },
    },
  },
};

describe("types for a stripe-python release that ships none", () => {
  it("declares each generated class's fields as stripe-python 7 would", () => {
    const classes = classFields(spec as never, {
      subscription: "stripe.Subscription",
      customer: "stripe.Customer",
      tax_rate: "stripe.TaxRate",
      // A nested class is not in a release before 7, and is left out.
      subscription_automatic_tax: "stripe.Subscription.AutomaticTax",
    });
    expect(classes).toEqual([
      {
        module: "api_resources/subscription.py",
        className: "Subscription",
        fields: {
          id: "str",
          current_period_end: "int",
          cancel_at: "Optional[int]",
          customer: 'Union[str, "stripe.Customer"]',
          items: "Any",
          default_tax_rates: 'List["stripe.TaxRate"]',
          automatic_tax: "Any",
        },
      },
      {
        module: "api_resources/customer.py",
        className: "Customer",
        fields: { email: "Optional[str]" },
      },
    ]);
  });

  it("writes them at the top of the class, past what it already defines", () => {
    const module = [
      "# -*- coding: utf-8 -*-",
      "from __future__ import absolute_import, division, print_function",
      "",
      "from stripe.api_resources.abstract import CreateableAPIResource",
      "",
      "",
      "class Subscription(",
      "    CreateableAPIResource,",
      "):",
      '    OBJECT_NAME = "subscription"',
      "",
      "    def cancel(self, **params):",
      "        return self._request('delete', params=params)",
      "",
    ].join("\n");
    expect(
      withFields(module, "Subscription", {
        current_period_end: "int",
        cancel: "Any",
        OBJECT_NAME: "str",
      }),
    ).toBe(
      [
        "# -*- coding: utf-8 -*-",
        "from __future__ import absolute_import, division, print_function",
        "import stripe",
        "from typing import Any, List, Optional, Union",
        "",
        "from stripe.api_resources.abstract import CreateableAPIResource",
        "",
        "",
        "class Subscription(",
        "    CreateableAPIResource,",
        "):",
        "    current_period_end: int",
        '    OBJECT_NAME = "subscription"',
        "",
        "    def cancel(self, **params):",
        "        return self._request('delete', params=params)",
        "",
      ].join("\n"),
    );
    expect(withFields(module, "Invoice", { id: "str" })).toBe(module);
  });
});
