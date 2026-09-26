"use strict";
// File generated from our OpenAPI spec
Object.defineProperty(exports, "__esModule", { value: true });
exports.Checkout = exports.SessionResource = void 0;
const StripeResource_js_1 = require("../../StripeResource.js");
class SessionResource extends StripeResource_js_1.StripeResource {
    /**
     * Creates a Checkout Session object.
     */
    create(params, options) {
        return this._makeRequest('POST', '/v1/checkout/sessions', params, options, {
            responseSchema: {
                kind: 'object',
                fields: {
                    currency_conversion: {
                        kind: 'nullable',
                        inner: {
                            kind: 'object',
                            fields: { fx_rate: { kind: 'decimal_string' } },
                        },
                    },
                },
            },
        });
    }
}
exports.SessionResource = SessionResource;
