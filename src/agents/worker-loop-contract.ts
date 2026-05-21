import { normalizeToolAction } from "../tools/local-tools.js";
import { validateLocalToolActionInputs } from "../tools/tool-contracts.js";
import type { PromptCacheOptions, PromptInput, ProviderUsageContext } from "../providers/openai-provider.js";
import type { SandboxDecision } from "../runtime/sandbox-policy.js";

export type WorkerToolCall = {
  id?: string;
  action?: string;
  inputs?: Record<string, unknown>;
  reason?: string;
};

export type WorkerToolResult = {
  id: string;
  action: string;
  reason?: string;
  status?: string;
  summary: string;
  content?: string;
  outputRef?: string;
  data?: unknown;
  errors?: unknown;
  errorCode?: string;
  retryable?: boolean;
  recoverable?: boolean;
  recoverySuggestion?: string;
  sandbox?: SandboxDecision;
};

export type WorkerToolProgressPayload = {
  message: string;
  tool_call_id: string;
  tool_calls_completed: number;
  remaining_tool_calls: number;
  action: string;
  status: string;
  summary?: string;
  errorCode?: string;
  outputRef?: string;
  recoverySuggestion?: string;
  reason?: string;
};

export type WorkerModelResult = {
  status: "completed" | "failed";
  summary: string;
  details: string;
  files_touched: string[];
  next_actions: string[];
};

export type WorkerLoopParsedResult = WorkerModelResult & {
  tool_calls: WorkerToolCall[];
};

export type WorkerLoopRepairInput = {
  originalText: string;
  validationError: string;
  generateText: (input: {
    system: PromptInput;
    user: PromptInput;
    model?: string;
    cache?: PromptCacheOptions;
    usage?: ProviderUsageContext;
    responseFormat?: "json_object";
    maxOutputTokens?: number;
  }) => Promise<string>;
  model?: string;
  task?: unknown;
  context?: unknown[];
  toolResults?: unknown;
  loop?: {
    turn: number;
    remaining_turns: number;
    remaining_tool_calls: number;
  };
  cacheKey?: string;
  usage?: ProviderUsageContext;
  maxOutputTokens?: number;
};

export function parseWorkerLoopModelResult(text: string): WorkerLoopParsedResult {
  const parsed = parseJsonObject(text);
  const details = typeof parsed.details === "string" && parsed.details.trim() ? parsed.details : text;
  return {
    status: parsed.status === "failed" ? "failed" : "completed",
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim().slice(0, 240) : firstLine(details),
    details,
    files_touched: Array.isArray(parsed.files_touched) ? parsed.files_touched.map(String) : [],
    next_actions: Array.isArray(parsed.next_actions) ? parsed.next_actions.map(String) : [],
    tool_calls: parseWorkerToolCallsFromValue(parsed.tool_calls)
  };
}

export function validateWorkerLoopToolCalls(toolCalls: WorkerToolCall[]): string | undefined {
  const invalid = toolCalls.find((call) => typeof call.action !== "string" || !call.action.trim());
  if (invalid) {
    return "worker tool_calls contained an empty or missing action value.";
  }
  const malformed = toolCalls
    .map((call) => validateWorkerToolCallInputs(call))
    .find((message): message is string => Boolean(message));
  if (malformed) {
    return malformed;
  }
  return undefined;
}

export function invalidWorkerLoopModelResult(validationError: string, text: string): WorkerLoopParsedResult {
  return {
    status: "failed",
    summary: `Invalid worker tool call JSON: ${validationError}`,
    details: [
      `Swarm worker could not repair the model tool call JSON: ${validationError}`,
      `Model output preview: ${truncateTextBytes(text, 2_000)}`
    ].join("\n"),
    files_touched: [],
    next_actions: ["Retry the worker task with explicit tool_calls action names and required inputs."],
    tool_calls: []
  };
}

export function buildWorkerToolProgressPayload(input: {
  call: WorkerToolCall;
  result: Partial<WorkerToolResult> & Pick<WorkerToolResult, "id" | "summary">;
  toolCallsCompleted: number;
  remainingToolCalls: number;
}): WorkerToolProgressPayload {
  const action = workerToolActionName(input.call, input.result.action);
  const status = typeof input.result.status === "string" && input.result.status.trim()
    ? input.result.status.trim()
    : "completed";
  const summary = typeof input.result.summary === "string" && input.result.summary.trim()
    ? input.result.summary.trim()
    : undefined;
  return {
    message: `Worker tool ${action} ${status}${summary ? `: ${firstLine(summary)}` : ""}`,
    tool_call_id: input.result.id,
    tool_calls_completed: input.toolCallsCompleted,
    remaining_tool_calls: input.remainingToolCalls,
    action,
    status,
    summary,
    errorCode: typeof input.result.errorCode === "string" && input.result.errorCode.trim() ? input.result.errorCode.trim() : undefined,
    outputRef: typeof input.result.outputRef === "string" && input.result.outputRef.trim() ? input.result.outputRef : undefined,
    recoverySuggestion: typeof input.result.recoverySuggestion === "string" && input.result.recoverySuggestion.trim()
      ? input.result.recoverySuggestion.trim()
      : undefined,
    reason: typeof input.result.reason === "string" && input.result.reason.trim() ? input.result.reason.trim() : undefined
  };
}

export async function repairWorkerLoopModelResult(input: WorkerLoopRepairInput): Promise<WorkerLoopParsedResult> {
  const repaired = await input.generateText({
    model: input.model,
    system: [{
      text: [
        "You repair invalid JSON for a Swarm worker loop.",
        "Return exactly one valid JSON object and nothing else.",
        "The object must contain keys: status, summary, details, files_touched, next_actions, tool_calls.",
        "status must be completed or failed.",
        "tool_calls must be an array.",
        "Every worker tool call must include a non-empty action string and required inputs.",
        `Validation error: ${input.validationError}`
      ].join(" "),
      cache: true
    }],
    user: JSON.stringify({
      task: input.task,
      context: input.context ?? [],
      tool_results: input.toolResults,
      loop: input.loop,
      invalid_output: input.originalText,
      validation_error: input.validationError
    }, null, 2),
    cache: input.cacheKey ? { key: input.cacheKey, ttlSeconds: 3600 } : undefined,
    usage: input.usage,
    responseFormat: "json_object",
    maxOutputTokens: input.maxOutputTokens
  });
  const parsed = parseWorkerLoopModelResult(repaired);
  const repairedValidationError = validateWorkerLoopToolCalls(parsed.tool_calls);
  if (repairedValidationError) {
    return invalidWorkerLoopModelResult(repairedValidationError, repaired);
  }
  return parsed;
}

function validateWorkerToolCallInputs(call: WorkerToolCall): string | undefined {
  try {
    const action = normalizeToolAction({ ...(call.inputs ?? {}), action: call.action ?? call.inputs?.action });
    return validateLocalToolActionInputs(action);
  } catch (error) {
    return `worker tool_call ${call.id ?? call.action ?? "unknown"} has invalid inputs: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function workerToolActionName(call: WorkerToolCall, actionOverride?: string): string {
  return typeof actionOverride === "string" && actionOverride.trim()
    ? actionOverride.trim()
    : typeof call.action === "string" && call.action.trim()
      ? call.action.trim()
      : typeof call.inputs?.action === "string" && call.inputs.action.trim()
        ? call.inputs.action.trim()
        : "unknown";
}

function parseWorkerToolCallsFromValue(value: unknown): WorkerToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item): WorkerToolCall | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }
      const rawInputs = item.inputs;
      return {
        id: typeof item.id === "string" ? item.id : undefined,
        action: typeof item.action === "string" ? item.action : typeof item.type === "string" ? item.type : undefined,
        inputs: isRecord(rawInputs) ? rawInputs : {},
        reason: typeof item.reason === "string" ? item.reason : undefined
      };
    })
    .filter((item): item is WorkerToolCall => item !== undefined);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return {};
    }
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 180) ?? "Completed";
}

function truncateTextBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  return `${buffer.subarray(0, Math.max(0, maxBytes - 20)).toString("utf8").trimEnd()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
