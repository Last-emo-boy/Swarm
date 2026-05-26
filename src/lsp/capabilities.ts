import type { LspToolAction } from "./types.js";

export type LspCapabilityMode =
  | "stdio"
  | "typescript_semantic_fallback"
  | "file_tools_fallback"
  | "unavailable";

export type LspFallbackReason =
  | "semantic_fallback"
  | "unsupported_language"
  | "provider_unavailable"
  | "provider_failed"
  | "partial_capability"
  | "request_timeout"
  | "symbol_not_found"
  | "unknown";

export type LspCapabilityFact = {
  action: LspToolAction["type"];
  available: boolean;
  mode: LspCapabilityMode;
  fallback_reason?: LspFallbackReason;
  reason?: string;
  next_action?: string;
  fallback_tools?: string[];
};

export type LspCapabilityProviderInput = {
  providerId: string;
  status?: string;
  commandAvailable: boolean;
  semanticFallback: boolean;
  detected: boolean;
  command?: string;
  envPrefix?: string;
  reason?: string;
  lastError?: string;
  serverCapabilities?: Record<string, unknown>;
};

export const LSP_TOOL_ACTIONS: Array<LspToolAction["type"]> = [
  "lsp.diagnostics",
  "lsp.hover",
  "lsp.definition",
  "lsp.references",
  "lsp.document_symbols",
  "lsp.workspace_symbols",
  "lsp.completion",
  "lsp.code_actions",
  "lsp.rename_preview",
  "lsp.format"
];

const FILE_FALLBACK_TOOLS = ["file.grep", "file.read"];

export function lspCapabilityFactsForProvider(input: LspCapabilityProviderInput): LspCapabilityFact[] {
  if (!input.detected && !input.commandAvailable) {
    return [];
  }

  if (input.semanticFallback && !input.commandAvailable) {
    return LSP_TOOL_ACTIONS.map((action) => ({
      action,
      available: true,
      mode: "typescript_semantic_fallback",
      fallback_reason: "semantic_fallback",
      reason: "Using in-process TypeScript semantic provider fallback.",
      next_action: "Semantic tools are available locally. Install typescript-language-server only if an external stdio LSP server is required.",
      fallback_tools: FILE_FALLBACK_TOOLS
    }));
  }

  if (input.status === "failed" || input.status === "exited") {
    const nextAction = "Restart the LSP provider, inspect lsp logs, or use file.grep/file.read until the provider is healthy.";
    return LSP_TOOL_ACTIONS.map((action) => ({
      action,
      available: false,
      mode: "file_tools_fallback",
      fallback_reason: "provider_failed",
      reason: input.lastError ?? input.reason ?? "LSP provider failed or exited.",
      next_action: nextAction,
      fallback_tools: FILE_FALLBACK_TOOLS
    }));
  }

  if (input.commandAvailable) {
    return LSP_TOOL_ACTIONS.map((action) => {
      const advertised = serverCapabilityAvailable(action, input.serverCapabilities);
      if (advertised === false) {
        return {
          action,
          available: false,
          mode: "file_tools_fallback",
          fallback_reason: "partial_capability",
          reason: `LSP provider did not advertise ${action}.`,
          next_action: "Use a supported LSP action or fall back to file.grep/file.read for this query.",
          fallback_tools: FILE_FALLBACK_TOOLS
        };
      }
      return {
        action,
        available: true,
        mode: "stdio",
        reason: advertised === true
          ? "LSP server advertised this capability."
          : "LSP command is available; capability will be confirmed after provider startup."
      };
    });
  }

  const install = input.command && input.envPrefix
    ? `Install ${input.command} or set ${input.envPrefix}_COMMAND.`
    : "Install or configure the matching LSP provider.";
  return LSP_TOOL_ACTIONS.map((action) => ({
    action,
    available: false,
    mode: input.detected ? "file_tools_fallback" : "unavailable",
    fallback_reason: "provider_unavailable",
    reason: input.reason ?? install,
    next_action: `${install} Use file.grep/file.read until semantic support is available.`,
    fallback_tools: FILE_FALLBACK_TOOLS
  }));
}

export function lspFallbackFactForFailure(input: {
  action: string;
  code?: string;
  language?: string;
  root?: string;
  fallback?: string;
  message?: string;
}): Pick<LspCapabilityFact, "fallback_reason" | "reason" | "next_action" | "fallback_tools" | "mode" | "available"> {
  const reason = normalizeFailureReason(input.code);
  const fallback = input.fallback ?? fallbackNextAction(input.action, input.language, input.root, reason);
  return {
    available: false,
    mode: "file_tools_fallback",
    fallback_reason: reason,
    reason: input.message ?? failureSummary(reason, input.language),
    next_action: fallback,
    fallback_tools: FILE_FALLBACK_TOOLS
  };
}

function serverCapabilityAvailable(action: LspToolAction["type"], capabilities: Record<string, unknown> | undefined): boolean | undefined {
  if (!capabilities) {
    return undefined;
  }
  switch (action) {
    case "lsp.diagnostics":
      return capabilities.textDocumentSync !== undefined;
    case "lsp.hover":
      return Boolean(capabilities.hoverProvider);
    case "lsp.definition":
      return Boolean(capabilities.definitionProvider);
    case "lsp.references":
      return Boolean(capabilities.referencesProvider);
    case "lsp.document_symbols":
      return Boolean(capabilities.documentSymbolProvider);
    case "lsp.workspace_symbols":
      return Boolean(capabilities.workspaceSymbolProvider);
    case "lsp.completion":
      return Boolean(capabilities.completionProvider);
    case "lsp.code_actions":
      return Boolean(capabilities.codeActionProvider);
    case "lsp.rename_preview":
      return Boolean(capabilities.renameProvider);
    case "lsp.format":
      return Boolean(capabilities.documentFormattingProvider);
  }
}

function normalizeFailureReason(code: string | undefined): LspFallbackReason {
  const normalized = (code ?? "").toLowerCase();
  if (normalized === "unsupported_language") return "unsupported_language";
  if (normalized === "request_timeout") return "request_timeout";
  if (normalized === "symbol_not_found") return "symbol_not_found";
  if (normalized === "lsp_unavailable" || normalized === "provider_unavailable") return "provider_unavailable";
  if (normalized === "lsp_failed" || normalized === "failed") return "provider_failed";
  if (normalized === "partial_capability") return "partial_capability";
  return "unknown";
}

function fallbackNextAction(action: string, language: string | undefined, root: string | undefined, reason: LspFallbackReason): string {
  const target = root ? ` under ${root}` : "";
  if (reason === "unsupported_language") {
    return `Use file.grep/file.read${target}, or install/configure an LSP provider for ${language ?? "this language"}.`;
  }
  if (reason === "symbol_not_found") {
    return "Verify the line/column points at a symbol, try document/workspace symbols, or use file.grep/file.read.";
  }
  if (reason === "request_timeout") {
    return "Retry with a narrower file/query or longer timeout, or fall back to file.grep/file.read.";
  }
  if (reason === "provider_unavailable" || reason === "provider_failed") {
    return "Configure or restart the LSP provider, or use file.grep/file.read until semantic support is healthy.";
  }
  if (reason === "partial_capability") {
    return `The provider does not support ${action}; use another LSP action or file.grep/file.read.`;
  }
  return "Inspect the LSP status and fall back to file.grep/file.read if semantic support is unavailable.";
}

function failureSummary(reason: LspFallbackReason, language: string | undefined): string {
  if (reason === "unsupported_language") return `No semantic LSP provider is available for ${language ?? "this language"}.`;
  if (reason === "request_timeout") return "LSP request timed out.";
  if (reason === "symbol_not_found") return "LSP could not resolve a symbol at the requested position.";
  if (reason === "provider_unavailable") return "LSP provider is unavailable.";
  if (reason === "provider_failed") return "LSP provider failed.";
  if (reason === "partial_capability") return "LSP provider does not support the requested capability.";
  return "LSP semantic support is unavailable.";
}
