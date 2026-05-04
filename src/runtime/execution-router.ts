import { OpenAIProvider } from "../providers/openai-provider.js";

export type RunMode = "auto" | "chat" | "coding_loop" | "full_swarm";

export type RunOptions = {
  mode?: RunMode;
};

export type ExecutionRoute = {
  mode: Exclude<RunMode, "auto">;
  reason: string;
  confidence: number;
};

export async function routeExecution(
  objective: string,
  provider: OpenAIProvider,
  options: RunOptions = {}
): Promise<ExecutionRoute> {
  if (options.mode && options.mode !== "auto") {
    return { mode: options.mode, reason: `forced:${options.mode}`, confidence: 1 };
  }

  const content = await provider.generateText({
    model: provider.workerModel,
    system: [
      "You are Swarm's execution mode classifier for a local coding CLI.",
      "Classify the user's request into exactly one mode.",
      "Return exactly one JSON object with keys: mode, confidence, reason.",
      "mode must be one of: chat, coding_loop, full_swarm.",
      "chat: answer or discuss without inspecting or modifying the workspace.",
      "coding_loop: default for local coding CLI work, including reading files, editing, running checks, creating projects, or iterating in the current workspace.",
      "full_swarm: use only for broad, parallel, multi-agent work such as whole-repo audits, large research, multi-module implementation, or requests explicitly asking for swarm/multiple agents.",
      "Do not include Markdown fences or prose outside JSON."
    ].join(" "),
    user: JSON.stringify({ objective }, null, 2)
  });
  try {
    return parseRoute(content);
  } catch (error) {
    const repaired = await provider.generateText({
      model: provider.workerModel,
      system: [
        "You repair invalid JSON for Swarm's execution mode classifier.",
        "Return exactly one valid JSON object and nothing else.",
        "The object must have keys: mode, confidence, reason.",
        "mode must be one of: chat, coding_loop, full_swarm.",
        "Use the original user objective and the invalid model output to infer the intended mode."
      ].join(" "),
      user: JSON.stringify({
        objective,
        invalid_output: content,
        parse_error: error instanceof Error ? error.message : String(error)
      }, null, 2)
    });
    return parseRoute(repaired);
  }
}

function parseRoute(text: string): ExecutionRoute {
  const parsed = parseJsonObject(text);
  const mode = parsed.mode;
  if (mode !== "chat" && mode !== "coding_loop" && mode !== "full_swarm") {
    throw new Error(`Execution classifier returned invalid mode: ${typeof mode === "string" ? mode : "(missing)"}`);
  }
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0;
  const reason = typeof parsed.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim().slice(0, 500)
    : "LLM classifier selected this mode.";
  return { mode, confidence, reason };
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Execution classifier returned non-JSON output.");
    }
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      throw new Error("Execution classifier returned invalid JSON.");
    }
  }
}
