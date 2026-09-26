// File generated from our OpenAPI spec

declare module 'stripe' {
  namespace Stripe {
    /**
     * A line item.
     */
    interface LineItem {
      /**
       * Unique identifier for the object.
       */
      id: string;

      /**
       * String representing the object's type. Objects of the same type share the same value.
       */
      object: 'item';

      /**
       * Total discount amount applied. If no discounts were applied, defaults to 0.
       */
      amount_discount: number;

      amount_subtotal: number;

      amount_total: number;

      currency: string;
    }
  }
}
