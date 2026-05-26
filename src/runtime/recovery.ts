import type { ResultCardPromptCacheStatus } from "./prompt-cache-status.js";
import type { SandboxDecision } from "./sandbox-policy.js";

export type RecoveryCategory =
  | "read_root"
  | "sandbox"
  | "permission"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_config"
  | "cache"
  | "lsp"
  | "tool"
  | "unknown";

export type RecoveryAdvice = {
  category: RecoveryCategory;
  severity: "info" | "warning" | "error";
  retryable: boolean;
  summary: string;
  nextAction: string;
  commandHint?: string;
  detail?: string;
};

export type ToolFailureRecoveryInput = {
  action: string;
  reason: string;
  errorCode?: string;
  recoverySuggestion?: string;
  sandbox?: SandboxDecision;
};

export function recoveryAdviceFromToolFailure(input: ToolFailureRecoveryInput): RecoveryAdvice {
  const reason = redactSensitive(input.reason);
  const suggestion = redactSensitive(input.recoverySuggestion ?? fallbackToolRecovery(input.errorCode, reason));
  const readRoot = readRootCommandHint(reason) ?? readRootCommandHint(suggestion);
  if (readRoot) {
    return {
      category: "read_root",
      severity: "warning",
      retryable: true,
      summary: "Read target is outside the current read roots.",
      nextAction: "Add the missing read root, then retry the same read.",
      commandHint: readRoot,
      detail: compactDetail(reason)
    };
  }
  if (input.sandbox?.decision === "deny") {
    return {
      category: "sandbox",
      severity: "error",
      retryable: true,
      summary: sandboxRecoverySummary(input.sandbox),
      nextAction: suggestion,
      detail: compactDetail(reason)
    };
  }
  const provider = recoveryAdviceFromProviderError({ message: reason, errorCode: input.errorCode });
  if (provider) {
    return provider;
  }
  if (input.errorCode === "PERMISSION_DENIED") {
    return {
      category: "permission",
      severity: "error",
      retryable: false,
      summary: "Permission policy denied the tool action.",
      nextAction: suggestion,
      detail: compactDetail(reason)
    };
  }
  if (input.errorCode === "TOOL_DEFERRED") {
    return {
      category: "tool",
      severity: "info",
      retryable: true,
      summary: "Requested tool is deferred until discovery.",
      nextAction: suggestion,
      commandHint: "ToolSearch",
      detail: compactDetail(reason)
    };
  }
  if (input.errorCode === "FS_NOT_FOUND") {
    return {
      category: "tool",
      severity: "warning",
      retryable: true,
      summary: "Path or file was not found.",
      nextAction: suggestion,
      commandHint: "file.list / file.glob",
      detail: compactDetail(reason)
    };
  }
  return {
    category: "tool",
    severity: input.errorCode === "INVALID_INPUT" ? "warning" : "error",
    retryable: input.errorCode !== "INVALID_INPUT" && input.errorCode !== "PERMISSION_DENIED",
    summary: `Tool action ${input.action} failed.`,
    nextAction: suggestion,
    detail: compactDetail(reason)
  };
}

export function recoveryAdviceFromLspFailure(input: {
  code?: string;
  language?: string;
  action?: string;
  fallback?: string;
  root?: string;
}): RecoveryAdvice | undefined {
  const code = (input.code ?? "").toLowerCase();
  if (code === "unsupported_language") {
    const language = input.language ?? "unknown";
    return {
      category: "lsp",
      severity: "warning",
      retryable: true,
      summary: `No semantic LSP provider is available for ${language}.`,
      nextAction: redactSensitive(input.fallback ?? `Fall back to file.grep/file.read, or add an LSP provider for ${language}.`),
      commandHint: "file.grep / file.read",
      detail: input.root ? `root=${redactSensitive(input.root)}` : undefined
    };
  }
  if (code === "request_timeout") {
    return {
      category: "lsp",
      severity: "warning",
      retryable: true,
      summary: "LSP request timed out.",
      nextAction: redactSensitive(input.fallback ?? "Retry with a narrower file/query or fall back to grep/read."),
      commandHint: "lsp.* with maxResults/timeoutMs",
      detail: input.action ? `action=${input.action}` : undefined
    };
  }
  return undefined;
}

export function recoveryAdviceFromProviderError(input: {
  message: string;
  errorCode?: string;
  statusCode?: number;
}): RecoveryAdvice | undefined {
  const message = redactSensitive(input.message);
  const combined = `${input.errorCode ?? ""} ${message}`;
  const statusCode = input.statusCode ?? statusCodeFromText(combined);
  if (statusCode === 429 || /rate.?limit|too many requests|quota/i.test(combined)) {
    return {
      category: "provider_rate_limit",
      severity: "warning",
      retryable: true,
      summary: "Model provider rate limit or quota was hit.",
      nextAction: "Wait and retry, reduce concurrency, or switch to a less constrained model/provider.",
      commandHint: "swarm run --max-agents 1",
      detail: compactDetail(message)
    };
  }
  if (/timeout|timed out|etimedout|deadline/i.test(combined)) {
    return {
      category: "provider_timeout",
      severity: "warning",
      retryable: true,
      summary: "Model provider request timed out.",
      nextAction: "Retry with a longer timeout, narrower context, lower concurrency, or a fallback model.",
      commandHint: "swarm run --max-agents 1",
      detail: compactDetail(message)
    };
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /invalid api key|missing api key|unauthorized|forbidden|authentication|auth/i.test(combined)
  ) {
    return {
      category: "provider_config",
      severity: "error",
      retryable: false,
      summary: "Model provider authentication or configuration failed.",
      nextAction: "Check endpoint, model name, and API key configuration, then retry.",
      commandHint: "swarm doctor",
      detail: compactDetail(message)
    };
  }
  return undefined;
}

export function recoveryAdviceFromCacheStatus(status: ResultCardPromptCacheStatus | undefined): RecoveryAdvice | undefined {
  if (!status) {
    return undefined;
  }
  if (status.outcome !== "miss" && status.outcome !== "bypass" && status.status !== "changed" && status.status !== "cache_miss") {
    return undefined;
  }
  const nextAction = status.recommendation
    ?? (status.status === "changed"
      ? "Keep tool schemas, stable system text, model, cache key, and long-lived workspace context unchanged across turns."
      : "Check provider cache support, model compatibility, TTL, and whether the same prompt prefix was reused.");
  return {
    category: "cache",
    severity: "info",
    retryable: true,
    summary: status.reason ?? `Prompt cache reported ${status.status}.`,
    nextAction,
    detail: [
      status.status ? `status=${status.status}` : undefined,
      status.missReason ? `miss_reason=${status.missReason}` : undefined,
      status.diagnostics ? `diagnostics=${status.diagnostics}` : undefined,
      status.changedSections?.length ? `changed_sections=${status.changedSections.slice(0, 4).join(",")}` : undefined,
      status.changed?.length ? `changed=${status.changed.slice(0, 4).join(",")}` : undefined
    ].filter(Boolean).join(" ") || undefined
  };
}

export function recoveryAdviceFromSuggestion(input: {
  suggestion: string;
  errorCode?: string;
  summary?: string;
}): RecoveryAdvice {
  return recoveryAdviceFromToolFailure({
    action: "tool",
    reason: input.summary ?? input.suggestion,
    errorCode: input.errorCode,
    recoverySuggestion: input.suggestion
  });
}

export function formatRecoveryAdvice(advice: RecoveryAdvice): string {
  return [
    `Recovery detail: [${advice.category}/${advice.severity}${advice.retryable ? "/retryable" : "/manual"}] ${advice.summary}`,
    `Next: ${advice.nextAction}`,
    advice.commandHint ? `Command: ${advice.commandHint}` : undefined,
    advice.detail ? `Detail: ${advice.detail}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatRecoveryAdviceInline(advice: RecoveryAdvice): string {
  return [
    `[${advice.category}/${advice.severity}${advice.retryable ? "/retry" : ""}]`,
    advice.summary,
    `Next: ${advice.nextAction}`,
    advice.commandHint ? `Hint: ${advice.commandHint}` : undefined
  ].filter(Boolean).join(" ");
}

export function redactSensitive(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-REDACTED")
    .replace(/\b(api[_-]?key|apikey|token|secret|password)\s*[:=]\s*["']?[^"'\s,;]+/gi, "$1=REDACTED")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer REDACTED")
    .replace(/(authorization\s*[:=]\s*)["']?Bearer\s+[^"'\s,;]+/gi, "$1Bearer REDACTED");
}

function fallbackToolRecovery(errorCode: string | undefined, reason: string): string {
  if (errorCode === "PERMISSION_DENIED") {
    return "Inspect the approval or permission rule, then retry with a narrower command or explicitly allow the action.";
  }
  if (errorCode === "FS_NOT_FOUND") {
    return "Run file.list, file.glob, or git.status to confirm the path, then retry with the resolved workspace-relative path.";
  }
  if (errorCode === "INVALID_INPUT") {
    return "Correct the tool arguments and retry; use file.read or tool context to build a more precise request.";
  }
  if (/timeout|timed out/i.test(reason)) {
    return "Retry with a longer timeout or a narrower command that produces less output.";
  }
  return "Inspect the tool output, adjust the command or inputs, and retry from the current workspace state.";
}

function readRootCommandHint(value: string): string | undefined {
  const match = value.match(/(?:suggestion=)?(?:Add a read root before retrying:\s*)?(\/add-dir\s+[^\r\n]+?)(?:\s+or\s+swarm run --add-dir|\s*$)/i);
  if (match?.[1]) {
    return redactSensitive(match[1].trim());
  }
  const preflight = value.match(/use\s+(\/add-dir\s+[^\r\n]+?)\s+before tool reads/i);
  return preflight?.[1] ? redactSensitive(preflight[1].trim()) : undefined;
}

function sandboxRecoverySummary(sandbox: SandboxDecision): string {
  if (sandbox.subject === "tool_action") {
    return `Sandbox ${sandbox.policy} blocked ${sandbox.action ?? "the tool action"}.`;
  }
  return `Sandbox ${sandbox.policy} blocked capability ${sandbox.capability_id ?? "unknown"}.`;
}

function statusCodeFromText(value: string): number | undefined {
  const match = value.match(/\b(?:HTTP_|status(?:Code)?[=: ]?)?(401|403|429)\b/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

function compactDetail(value: string | undefined, maxLength = 240): string | undefined {
  const line = redactSensitive(value)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) {
    return undefined;
  }
  return line.length > maxLength ? `${line.slice(0, Math.max(0, maxLength - 3))}...` : line;
}
