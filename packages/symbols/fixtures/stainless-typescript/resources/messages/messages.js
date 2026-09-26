"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Messages = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const headers_1 = require("../../internal/headers.js");
const BatchesAPI = tslib_1.__importStar(require("./batches.js"));
class Messages extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.batches = new BatchesAPI.Batches(this._client);
    }
    create(params, options) {
        const { user_profile_id, ...body } = params;
        if (body.model in DEPRECATED_MODELS) {
            console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS[body.model]}\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
        }
        let timeout = options?.timeout ?? this._client._options.timeout;
        return this._client.post('/v1/messages', {
            body,
            timeout: timeout ?? 600000,
            ...options,
            headers: (0, headers_1.buildHeaders)([
                { ...(user_profile_id != null ? { 'anthropic-user-profile-id': user_profile_id } : undefined) },
                options?.headers,
            ]),
            stream: params.stream ?? false,
        });
    }
}
exports.Messages = Messages;
