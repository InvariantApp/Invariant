"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Batches = void 0;
const resource_1 = require("../../core/resource.js");
const headers_1 = require("../../internal/headers.js");
const path_1 = require("../../internal/utils/path.js");
class Batches extends resource_1.APIResource {
    create(params, options) {
        const { user_profile_id, ...body } = params;
        return this._client.post('/v1/messages/batches', {
            body,
            ...options,
            headers: (0, headers_1.buildHeaders)([
                { ...(user_profile_id != null ? { 'anthropic-user-profile-id': user_profile_id } : undefined) },
                options?.headers,
            ]),
        });
    }
    retrieve(messageBatchID, options) {
        return this._client.get((0, path_1.path) `/v1/messages/batches/${messageBatchID}`, options);
    }
}
exports.Batches = Batches;
