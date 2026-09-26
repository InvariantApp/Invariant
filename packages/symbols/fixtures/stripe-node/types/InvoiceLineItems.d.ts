// File generated from our OpenAPI spec

declare module 'stripe' {
  namespace Stripe {
    /**
     * Invoice Line Items represent the individual lines within an [invoice](https://stripe.com/docs/api/invoices) and only exist within the context of an invoice.
     */
    interface InvoiceLineItem {
      /**
       * Unique identifier for the object.
       */
      id: string;

      /**
       * String representing the object's type. Objects of the same type share the same value.
       */
      object: 'line_item';

      /**
       * The amount, in cents (or local equivalent).
       */
      amount: number;

      currency: string;

      invoice: string | null;

      period: InvoiceLineItem.Period;
    }
  }
}
