/** The ticket host's model call through Swarm's configured provider: one JSON answer, on the worker model unless the settings name one. */
import type { Complete } from "./assessor.js";

export async function providerComplete(): Promise<Complete> {
  const { OpenAIProvider } = await import("../providers/openai-provider.js");
  const provider = new OpenAIProvider();
  return ({ purpose, system, user, model }) => provider.generateText({
    model: model ?? provider.workerModel, system: [{ text: system, cache: true }], user,
    responseFormat: "json_object", maxOutputTokens: 4000, usage: { purpose }
  });
}
