import { dirname, resolve } from "node:path";
import { detectLspWorkspaceRoot } from "./root-detection.js";
import { TypeScriptSemanticProvider } from "./typescript-provider.js";
import type { LspOperationResult, LspToolAction } from "./types.js";
import type { LocalToolContext, ToolResult } from "../tools/types.js";
import { displayPath, resolveReadablePath } from "../tools/permissions.js";
import { formatRecoveryAdvice, recoveryAdviceFromLspFailure } from "../runtime/recovery.js";

const PROVIDER_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

type CachedProvider = {
  provider: TypeScriptSemanticProvider;
  expiresAt: number;
};

const providers = new Map<string, CachedProvider>();

export async function runLspTool(action: LspToolAction, context: LocalToolContext): Promise<ToolResult> {
  const timeoutMs = timeoutForAction(action);
  return withTimeout(executeLspTool(action, context), timeoutMs, action.type, context);
}

async function executeLspTool(action: LspToolAction, context: LocalToolContext): Promise<ToolResult> {
  const requestedFile = "file" in action && action.file ? action.file : "path" in action ? action.path : undefined;
  const resolvedFile = requestedFile ? resolveReadablePath(requestedFile, context) : undefined;
  const resolvedRoot = "root" in action && action.root
    ? resolveReadablePath(action.root, context)
    : resolvedFile
      ? dirname(resolvedFile)
      : resolveReadablePath(".", context);
  const detection = await detectLspWorkspaceRoot({
    workspace: context.workspace,
    root: resolvedRoot,
    file: resolvedFile
  });
  if (detection.language && detection.language !== "typescript") {
    return unsupportedLanguage(action.type, detection.language, detection.workspaceRoot, context);
  }
  if (!detection.language && action.type !== "lsp.workspace_symbols" && !resolvedFile) {
    return unsupportedLanguage(action.type, "unknown", detection.workspaceRoot, context);
  }
  const provider = await getTypeScriptProvider(detection.workspaceRoot);
  const result = await runProviderAction(provider, action, resolvedFile);
  return toToolResult(action.type, result, context);
}

async function runProviderAction(provider: TypeScriptSemanticProvider, action: LspToolAction, file?: string): Promise<LspOperationResult<unknown>> {
  if (action.type === "lsp.diagnostics") {
    return provider.diagnostics({ file, maxResults: action.maxResults, contextLines: action.contextLines });
  }
  if (action.type === "lsp.hover") {
    return provider.hover({ file: requiredFile(file, action.type), line: lineForAction(action), column: columnForAction(action) });
  }
  if (action.type === "lsp.definition") {
    return provider.definition({ file: requiredFile(file, action.type), line: lineForAction(action), column: columnForAction(action), maxResults: resultLimit(action), contextLines: action.contextLines });
  }
  if (action.type === "lsp.references") {
    return provider.references({ file: requiredFile(file, action.type), line: lineForAction(action), column: columnForAction(action), maxResults: resultLimit(action), contextLines: action.contextLines });
  }
  if (action.type === "lsp.document_symbols") {
    return provider.documentSymbols({ file: requiredFile(file, action.type), maxResults: resultLimit(action) });
  }
  if (action.type === "lsp.workspace_symbols") {
    return provider.workspaceSymbols({ query: action.query ?? "", maxResults: resultLimit(action) });
  }
  if (action.type === "lsp.completion") {
    return provider.completion({ file: requiredFile(file, action.type), line: lineForAction(action), column: columnForAction(action), prefix: action.prefix, maxResults: resultLimit(action) });
  }
  if (action.type === "lsp.code_actions") {
    return provider.codeActions({ file: requiredFile(file, action.type), range: action.range, line: action.line, column: columnForAction(action), maxResults: resultLimit(action) });
  }
  if (action.type === "lsp.rename_preview") {
    return provider.renamePreview({ file: requiredFile(file, action.type), line: lineForAction(action), column: columnForAction(action), newName: action.newName, maxResults: resultLimit(action), contextLines: action.contextLines });
  }
  return provider.format({ file: requiredFile(file, action.type), maxResults: resultLimit(action) });
}

function lineForAction(action: { line?: number; lineZeroBased?: number }): number {
  return action.line ?? (action.lineZeroBased !== undefined ? action.lineZeroBased + 1 : 1);
}

function columnForAction(action: { column?: number; character?: number }): number {
  return action.column ?? (action.character !== undefined ? action.character + 1 : 1);
}

function resultLimit(action: { maxResults?: number; maxItems?: number }): number | undefined {
  return action.maxResults ?? action.maxItems;
}

async function getTypeScriptProvider(root: string): Promise<TypeScriptSemanticProvider> {
  const key = resolve(root);
  const cached = providers.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cached.expiresAt = Date.now() + PROVIDER_TTL_MS;
    return cached.provider;
  }
  const provider = await TypeScriptSemanticProvider.create(key);
  providers.set(key, { provider, expiresAt: Date.now() + PROVIDER_TTL_MS });
  return provider;
}

function toToolResult(action: string, result: LspOperationResult<unknown>, context: LocalToolContext): ToolResult {
  const status = result.status.code === "ready"
    ? "success"
    : result.status.code === "partial" || result.truncated
      ? "partial"
      : "failed";
  const recovery = status === "failed"
    ? recoveryAdviceFromLspFailure({
        code: result.status.code,
        language: result.status.language,
        action,
        fallback: recoverySuggestion(result.status.code),
        root: result.status.root ? displayPath(result.status.root, context.workspace) : undefined
      })
    : undefined;
  return {
    action,
    status,
    summary: result.summary,
    content: [result.content, recovery ? formatRecoveryAdvice(recovery) : undefined].filter(Boolean).join("\n"),
    data: result.data,
    errorCode: status === "failed" ? result.status.code : undefined,
    recoverable: status === "failed",
    recoverySuggestion: recoverySuggestion(result.status.code),
    recovery,
    metadata: {
      lsp_status: result.status.code,
      language: result.status.language,
      provider: result.status.provider,
      root: result.status.root ? displayPath(result.status.root, context.workspace) : undefined,
      message: result.status.message,
      truncated: result.truncated
    }
  };
}

function unsupportedLanguage(action: string, language: string, root: string, context: LocalToolContext): ToolResult {
  const fallback = lspFallbackSuggestion(action, language, root, context);
  const recovery = recoveryAdviceFromLspFailure({
    code: "unsupported_language",
    language,
    action,
    fallback,
    root: displayPath(root, context.workspace)
  });
  return {
    action,
    status: "failed",
    summary: `LSP unsupported language: ${language}`,
    content: [
      `No semantic provider is registered for ${language}.`,
      `root=${displayPath(root, context.workspace)}`,
      `fallback=${fallback}`,
      recovery ? formatRecoveryAdvice(recovery) : undefined
    ].join("\n"),
    errorCode: "unsupported_language",
    recoverable: true,
    recoverySuggestion: fallback,
    recovery,
    metadata: {
      lsp_status: "unsupported_language",
      language,
      root: displayPath(root, context.workspace)
    }
  };
}

function lspFallbackSuggestion(action: string, language: string, root: string, context: LocalToolContext): string {
  const readableRoot = displayPath(root, context.workspace);
  if (action === "lsp.workspace_symbols") {
    return `Use file.grep with root=${readableRoot} and a symbol/name query, or install/configure an LSP provider for ${language}.`;
  }
  if (action === "lsp.document_symbols") {
    return `Use file.read on the target file and file.grep within ${readableRoot}, or install/configure an LSP provider for ${language}.`;
  }
  if (action === "lsp.definition" || action === "lsp.references" || action === "lsp.hover") {
    return `Use file.grep for the symbol name under ${readableRoot}, then file.read matching files, or add an LSP provider for ${language}.`;
  }
  return `Fall back to file.grep/file.read under ${readableRoot}, or add an LSP provider for ${language}.`;
}

async function withTimeout(promise: Promise<ToolResult>, timeoutMs: number, action: string, context: LocalToolContext): Promise<ToolResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<ToolResult>((resolvePromise) => {
        timer = setTimeout(() => {
          const recovery = recoveryAdviceFromLspFailure({
            code: "request_timeout",
            action,
            fallback: "Retry with a narrower file/query or fall back to grep/read.",
            root: displayPath(context.workspace, context.workspace)
          });
          resolvePromise({
            action,
            status: "failed",
            summary: `LSP request timed out after ${timeoutMs} ms`,
            errorCode: "request_timeout",
            recoverable: true,
            recoverySuggestion: "Retry with a narrower file/query or fall back to grep/read.",
            recovery,
            content: recovery ? formatRecoveryAdvice(recovery) : undefined,
            metadata: {
              lsp_status: "request_timeout",
              workspace: displayPath(context.workspace, context.workspace)
            }
          });
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function timeoutForAction(action: LspToolAction): number {
  return Math.max(500, Math.min(60_000, "timeoutMs" in action && action.timeoutMs ? action.timeoutMs : DEFAULT_TIMEOUT_MS));
}

function requiredFile(file: string | undefined, action: string): string {
  if (!file) {
    throw new Error(`${action} requires file`);
  }
  return file;
}

function recoverySuggestion(code: string): string | undefined {
  if (code === "symbol_not_found") {
    return "Verify the 1-based line/column points at a symbol, or fall back to document/workspace symbols.";
  }
  if (code === "unsupported_language") {
    return "Fall back to file.grep/file.read, or add a language provider.";
  }
  if (code === "request_timeout") {
    return "Retry with a narrower file/query or fall back to grep/read.";
  }
  return undefined;
}
