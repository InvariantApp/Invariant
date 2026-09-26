// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import { buildHeaders } from "../../internal/headers.mjs";
import { path } from "../../internal/utils/path.mjs";
export class Batches extends APIResource {
    create(params, options) {
        const { user_profile_id, ...body } = params;
        return this._client.post('/v1/messages/batches', {
            body,
            ...options,
            headers: buildHeaders([
                { ...(user_profile_id != null ? { 'anthropic-user-profile-id': user_profile_id } : undefined) },
                options?.headers,
            ]),
        });
    }
    retrieve(messageBatchID, options) {
        return this._client.get(path `/v1/messages/batches/${messageBatchID}`, options);
    }
}
