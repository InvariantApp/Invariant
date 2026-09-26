import { StripeResource } from '../StripeResource.js';
import { Address, Metadata } from '../shared.js';
import { RequestOptions, Response } from '../lib.js';
export declare class CustomerResource extends StripeResource {
    /**
     * Permanently deletes a customer. It cannot be undone. Also immediately cancels any active subscriptions on the customer.
     */
    del(id: string, params?: CustomerDeleteParams, options?: RequestOptions): Promise<Response<DeletedCustomer>>;
    /**
     * Retrieves a Customer object.
     */
    retrieve(id: string, params?: CustomerRetrieveParams, options?: RequestOptions): Promise<Response<Customer | DeletedCustomer>>;
}
/**
 * This object represents a customer of your business.
 */
export interface Customer {
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
    address?: Address | null;
    balance: number;
    email: string | null;
}
/**
 * The DeletedCustomer object.
 */
export interface DeletedCustomer {
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
