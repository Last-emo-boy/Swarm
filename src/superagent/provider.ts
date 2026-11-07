/**
 * The ticket host's model call through Swarm's configured provider: one JSON answer, on the worker model unless the settings
 * name one. Each call's usage goes to this device's usage records, where the ledger counts it as an assessor call.
 */
import type { ProviderUsageHandler } from "../providers/openai-provider.js";
import type { Complete } from "./assessor.js";

export async function providerComplete(options: { onUsage?: ProviderUsageHandler } = {}): Promise<Complete> {
  const { OpenAIProvider } = await import("../providers/openai-provider.js");
  const provider = new OpenAIProvider({ onUsage: options.onUsage ?? await usageRecorder() });
  return ({ purpose, system, user, model }) => provider.generateText({
    model: model ?? provider.workerModel, system: [{ text: system, cache: true }], user,
    responseFormat: "json_object", maxOutputTokens: 4000, usage: { purpose }
  });
}

/** Records a call as Swarm's runtime records its own: one `llm_call` count row whose metadata is the whole usage report. */
async function usageRecorder(): Promise<ProviderUsageHandler> {
  const [{ loadSwarmSettings }, { SwarmDatabase }, { UsageStore }] = await Promise.all([
    import("../config/settings.js"), import("../storage/database.js"), import("../storage/usage-store.js")
  ]);
  let store: InstanceType<typeof UsageStore> | undefined;
  return (usage) => {
    try {
      store ??= new UsageStore(new SwarmDatabase(loadSwarmSettings().runtime.databasePath));
      store.append({ session_id: usage.sessionId, task_id: usage.taskId, kind: "llm_call", amount: 1, unit: "count", metadata: usage });
    } catch (error) {
      process.stderr.write(`superagent: could not record a model call's usage: ${String(error)}\n`);
    }
  };
}
