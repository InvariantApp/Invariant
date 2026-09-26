import { StripeResource } from '../../StripeResource.js';
import { RequestOptions, Response } from '../../lib.js';
export declare class SessionResource extends StripeResource {
    /**
     * Creates a session of the customer portal.
     */
    create(params: BillingPortal.SessionCreateParams, options?: RequestOptions): Promise<Response<Session>>;
}
/**
 * The Billing customer portal is a Stripe-hosted UI for subscription and
 * billing management.
 */
export interface Session {
    /**
     * Unique identifier for the object.
     */
    id: string;
    /**
     * String representing the object's type. Objects of the same type share the same value.
     */
    object: 'billing_portal.session';
    /**
     * The ID of the customer for this session.
     */
    customer: string;
    /**
     * The short-lived URL of the session that gives customers access to the customer portal.
     */
    url: string;
}
