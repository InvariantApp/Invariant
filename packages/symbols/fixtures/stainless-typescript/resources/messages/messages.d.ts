import { APIResource } from "../../core/resource.js";
import * as BatchesAPI from "./batches.js";
import { Batches, MessageBatch } from "./batches.js";
import { APIPromise } from "../../core/api-promise.js";
import { RequestOptions } from "../../internal/request-options.js";
export declare class Messages extends APIResource {
    batches: BatchesAPI.Batches;
    create(params: MessageCreateParamsNonStreaming, options?: RequestOptions): APIPromise<Message>;
}
export type ContentBlock = TextBlock;
export interface Message {
    /**
     * Unique object identifier.
     *
     * The format and length of IDs may change over time.
     */
    id: string;
    content: Array<ContentBlock>;
    model: Model;
    role: 'assistant';
    stop_reason: StopReason | null;
    type: 'message';
    usage: Usage;
}
export interface TextBlock {
    citations: Array<TextCitation> | null;
    text: string;
    type: 'text';
}
export interface TextBlockParam {
    text: string;
    type: 'text';
    citations?: Array<TextCitationParam> | null;
}
export interface Tool {
    /**
     * [JSON schema](https://json-schema.org/draft/2020-12) for this tool's input.
     */
    input_schema: Tool.InputSchema;
    name: string;
    description?: string;
}
export declare namespace Tool {
    interface InputSchema {
        type: 'object';
        properties?: unknown | null;
        required?: Array<string> | null;
        [k: string]: unknown;
    }
}
export interface MessageCreateParamsBase {
    max_tokens: number;
    messages: Array<MessageParam>;
    model: Model;
    stream?: boolean;
    tools?: Array<Tool>;
}
export interface MessageCreateParamsNonStreaming extends MessageCreateParamsBase {
    stream?: false;
}
export interface MessageCreateParamsStreaming extends MessageCreateParamsBase {
    stream: true;
}
export declare namespace Messages {
    export { type ContentBlock as ContentBlock, type Message as Message, type TextBlock as TextBlock, type TextBlockParam as TextBlockParam, type Tool as Tool, type MessageCreateParamsNonStreaming as MessageCreateParamsNonStreaming, type MessageCreateParamsStreaming as MessageCreateParamsStreaming, };
    export { Batches as Batches, type MessageBatch as MessageBatch, };
}
