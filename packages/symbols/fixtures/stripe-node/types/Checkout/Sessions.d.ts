// File generated from our OpenAPI spec

declare module 'stripe' {
  namespace Stripe {
    namespace Checkout {
      /**
       * A Checkout Session represents your customer's session as they pay for
       * one-time purchases or subscriptions through [Checkout](https://stripe.com/docs/payments/checkout)
       * or [Payment Links](https://stripe.com/docs/payments/payment-links). We recommend creating a
       * new Session each time your customer attempts to pay.
       */
      interface Session {
        /**
         * Unique identifier for the object.
         */
        id: string;

        /**
         * String representing the object's type. Objects of the same type share the same value.
         */
        object: 'checkout.session';

        /**
         * Total of all items before discounts or taxes are applied.
         */
        amount_subtotal: number | null;

        /**
         * Total of all items after discounts and taxes are applied.
         */
        amount_total: number | null;

        automatic_tax: Session.AutomaticTax;
      }

      namespace Session {
        interface AutomaticTax {
          /**
           * Indicates whether automatic tax is enabled for the session
           */
          enabled: boolean;

          /**
           * The status of the most recent automated tax calculation for this session.
           */
          status: AutomaticTax.Status | null;
        }
      }
    }
  }
}
