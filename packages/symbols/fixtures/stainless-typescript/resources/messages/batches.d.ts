import { APIResource } from "../../core/resource.js";
import { APIPromise } from "../../core/api-promise.js";
import { RequestOptions } from "../../internal/request-options.js";
export declare class Batches extends APIResource {
    create(params: BatchCreateParams, options?: RequestOptions): APIPromise<MessageBatch>;
    retrieve(messageBatchID: string, options?: RequestOptions): APIPromise<MessageBatch>;
}
export interface MessageBatch {
    /**
     * Unique object identifier.
     */
    id: string;
    archived_at: string | null;
    created_at: string;
    processing_status: 'in_progress' | 'canceling' | 'ended';
    type: 'message_batch';
}
export interface BatchCreateParams {
    requests: Array<unknown>;
}
