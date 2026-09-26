"use strict";
// File generated from our OpenAPI spec
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerResource = void 0;
const StripeResource_js_1 = require("../StripeResource.js");
class CustomerResource extends StripeResource_js_1.StripeResource {
    /**
     * Permanently deletes a customer. It cannot be undone. Also immediately cancels any active subscriptions on the customer.
     */
    del(id, params, options) {
        return this._makeRequest('DELETE', `/v1/customers/${encodeURIComponent(id)}`, params, options);
    }
    /**
     * Retrieves a Customer object.
     */
    retrieve(id, params, options) {
        return this._makeRequest('GET', `/v1/customers/${encodeURIComponent(id)}`, params, options);
    }
}
exports.CustomerResource = CustomerResource;
