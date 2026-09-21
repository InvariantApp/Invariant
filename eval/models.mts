/**
 * The S2 judge's connection to a model, made only where a key is present.
 *
 * The judge itself depends on nothing but the shape of `messages.create`, so
 * the CLI and the GitHub Action, which bundle the proposer and must never
 * call a model, carry no model client at all. This is where one is made: for
 * recording evaluations here, and later in the hosted service.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { type MessagesClient, S2_MODEL } from "@invariant/proposer";

/** Anthropic's client, seen through the one method the judge uses. */
export function anthropicMessages(client: Anthropic): MessagesClient {
  return {
    messages: {
      async create(params) {
        const message = await client.messages.create({ ...params, stream: false });
        return {
          model: message.model,
          content: message.content.map(
            (block) => ({ ...block }) as { type: string } & Record<string, unknown>,
          ),
          usage: {
            input_tokens: message.usage.input_tokens,
            output_tokens: message.usage.output_tokens,
          },
        };
      },
    },
  };
}

/**
 * The pinned model, checked against the provider's own list, so an answer is
 * never recorded against a model id that does not exist or has been retired.
 */
export async function verifiedModel(
  client: Anthropic,
  model = S2_MODEL,
): Promise<string> {
  const known: string[] = [];
  for await (const entry of client.models.list()) known.push(entry.id);
  if (!known.includes(model)) {
    throw new Error(
      `${model} is not a model this key can use. Known: ${known.slice(0, 12).join(", ")}`,
    );
  }
  return model;
}
