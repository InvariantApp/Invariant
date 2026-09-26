// File generated from our OpenAPI spec

declare module 'stripe' {
  namespace Stripe {
    /**
     * This object represents a customer of your business.
     */
    interface Customer {
      /**
       * Unique identifier for the object.
       */
      id: string;

      /**
       * String representing the object's type. Objects of the same type share the same value.
       */
      object: 'customer';

      /**
       * The customer's address.
       */
      address?: Stripe.Address | null;

      balance: number;

      email: string | null;
    }

    /**
     * The DeletedCustomer object.
     */
    interface DeletedCustomer {
      /**
       * Unique identifier for the object.
       */
      id: string;

      /**
       * String representing the object's type. Objects of the same type share the same value.
       */
      object: 'customer';

      /**
       * Always true for a deleted object
       */
      deleted: true;
    }
  }
}
