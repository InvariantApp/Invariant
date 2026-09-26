import { StripeResource } from '../../StripeResource.js';
import { RequestOptions, Response } from '../../lib.js';
export declare class SessionResource extends StripeResource {
    /**
     * Creates a Checkout Session object.
     */
    create(params?: Checkout.SessionCreateParams, options?: RequestOptions): Promise<Response<Session>>;
}
/**
 * A Checkout Session represents your customer's session as they pay for
 * one-time purchases or subscriptions through [Checkout](https://docs.stripe.com/payments/checkout)
 * or [Payment Links](https://docs.stripe.com/payments/payment-links). We recommend creating a
 * new Session each time your customer attempts to pay.
 */
export interface Session {
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
export declare namespace Session {
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
