import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { lspFallbackFactForFailure } from "./capabilities.js";
import { detectLspWorkspaceRoot } from "./root-detection.js";
import { TypeScriptSemanticProvider } from "./typescript-provider.js";
import type { LspOperationResult, LspRange, LspToolAction, SemanticEvidence } from "./types.js";
import type { LocalToolContext, ToolResult } from "../tools/types.js";
import { displayPath, resolveReadablePath } from "../tools/permissions.js";
import { formatRecoveryAdvice, recoveryAdviceFromLspFailure } from "../runtime/recovery.js";

const PROVIDER_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const SEMANTIC_EVIDENCE_SCHEMA_VERSION = "swarm.semantic_evidence.v1";

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
  const root = result.status.root ? displayPath(result.status.root, context.workspace) : undefined;
  const fallbackFact = status === "failed"
    ? lspFallbackFactForFailure({
        action,
        code: result.status.code,
        language: result.status.language,
        root,
        fallback: recoverySuggestion(result.status.code),
        message: result.status.message
      })
    : undefined;
  const recovery = status === "failed"
    ? recoveryAdviceFromLspFailure({
        code: result.status.code,
        language: result.status.language,
        action,
        fallback: fallbackFact?.next_action,
        root
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
    recoverySuggestion: fallbackFact?.next_action ?? recoverySuggestion(result.status.code),
    recovery,
    metadata: {
      lsp_status: result.status.code,
      language: result.status.language,
      provider: result.status.provider,
      root,
      message: result.status.message,
      truncated: result.truncated,
      ...(fallbackFact ? lspFallbackMetadata(fallbackFact) : {}),
      semantic_evidence: semanticEvidenceForResult({
        action,
        status,
        summary: result.summary,
        data: result.data,
        language: result.status.language,
        provider: result.status.provider,
        root,
        lspStatus: result.status.code,
        truncated: result.truncated,
        fallbackFact
      })
    }
  };
}

function unsupportedLanguage(action: string, language: string, root: string, context: LocalToolContext): ToolResult {
  const fallback = lspFallbackSuggestion(action, language, root, context);
  const fallbackFact = lspFallbackFactForFailure({
    action,
    code: "unsupported_language",
    language,
    root: displayPath(root, context.workspace),
    fallback,
    message: `No semantic provider is registered for ${language}.`
  });
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
    recoverySuggestion: fallbackFact.next_action,
    recovery,
    metadata: {
      lsp_status: "unsupported_language",
      language,
      root: displayPath(root, context.workspace),
      ...lspFallbackMetadata(fallbackFact),
      semantic_evidence: semanticEvidenceForResult({
        action,
        status: "failed",
        summary: `LSP unsupported language: ${language}`,
        language,
        root: displayPath(root, context.workspace),
        lspStatus: "unsupported_language",
        fallbackFact
      })
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
          const fallbackFact = lspFallbackFactForFailure({
            action,
            code: "request_timeout",
            root: displayPath(context.workspace, context.workspace),
            fallback: "Retry with a narrower file/query or fall back to file.grep/file.read."
          });
          const recovery = recoveryAdviceFromLspFailure({
            code: "request_timeout",
            action,
            fallback: fallbackFact.next_action,
            root: displayPath(context.workspace, context.workspace)
          });
          resolvePromise({
            action,
            status: "failed",
            summary: `LSP request timed out after ${timeoutMs} ms`,
            errorCode: "request_timeout",
            recoverable: true,
            recoverySuggestion: fallbackFact.next_action,
            recovery,
            content: recovery ? formatRecoveryAdvice(recovery) : undefined,
            metadata: {
              lsp_status: "request_timeout",
              workspace: displayPath(context.workspace, context.workspace),
              ...lspFallbackMetadata(fallbackFact),
              semantic_evidence: semanticEvidenceForResult({
                action,
                status: "failed",
                summary: `LSP request timed out after ${timeoutMs} ms`,
                root: displayPath(context.workspace, context.workspace),
                lspStatus: "request_timeout",
                fallbackFact
              })
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

function lspFallbackMetadata(fact: ReturnType<typeof lspFallbackFactForFailure>): Record<string, unknown> {
  return {
    fallback_reason: fact.fallback_reason,
    fallback_tools: fact.fallback_tools,
    next_action: fact.next_action,
    fallback_mode: fact.mode,
    fallback_available: fact.available,
    fallback_reason_detail: fact.reason
  };
}

function semanticEvidenceForResult(input: {
  action: string;
  status: "success" | "partial" | "failed";
  summary: string;
  data?: unknown;
  language?: string;
  provider?: string;
  root?: string;
  lspStatus?: string;
  truncated?: boolean;
  fallbackFact?: ReturnType<typeof lspFallbackFactForFailure>;
}): SemanticEvidence {
  const resultKeys = isRecord(input.data) ? Object.keys(input.data).sort() : [];
  const primaryRefs = semanticEvidenceRefs(input.data).slice(0, 8);
  const symbol = semanticEvidenceSymbol(input.data);
  const range = semanticEvidenceRange(input.data);
  const changedFiles = semanticEvidenceChangedFiles(input.data);
  const staleness = semanticEvidenceStaleness(input.status, input.lspStatus, Boolean(input.fallbackFact), input.truncated);
  const staleReason = staleness === "stale"
    ? input.truncated
      ? "semantic result was truncated; refresh with a narrower query before relying on complete coverage"
      : "semantic provider returned partial evidence"
    : undefined;
  const evidence = {
    schema_version: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    source: input.fallbackFact ? "fallback" : "lsp",
    action: input.action,
    status: input.status,
    lsp_status: input.lspStatus,
    language: input.language,
    provider: input.provider,
    root: input.root,
    symbol,
    range,
    confidence: semanticEvidenceConfidence(input.status, input.lspStatus),
    staleness,
    stale_reason: staleReason,
    fallback_used: Boolean(input.fallbackFact),
    fallback_reason: input.fallbackFact?.fallback_reason,
    fallback_tools: input.fallbackFact?.fallback_tools,
    next_action: input.fallbackFact?.next_action,
    truncated: input.truncated === true,
    summary: input.summary,
    result_keys: resultKeys,
    primary_refs: primaryRefs,
    changed_files: changedFiles
  };
  return {
    evidence_id: semanticEvidenceId(evidence),
    ...stripUndefined(evidence)
  } as SemanticEvidence;
}

function semanticEvidenceConfidence(status: "success" | "partial" | "failed", lspStatus: string | undefined): number {
  if (status === "success" && lspStatus === "ready") {
    return 0.9;
  }
  if (status === "partial" || lspStatus === "partial") {
    return 0.65;
  }
  return 0.25;
}

function semanticEvidenceStaleness(
  status: "success" | "partial" | "failed",
  lspStatus: string | undefined,
  fallbackUsed: boolean,
  truncated: boolean | undefined
): SemanticEvidence["staleness"] {
  if (fallbackUsed || status === "failed") {
    return "fallback";
  }
  if (status === "partial" || lspStatus === "partial" || truncated) {
    return "stale";
  }
  return "fresh";
}

function semanticEvidenceRefs(value: unknown): string[] {
  const refs = new Set<string>();
  collectSemanticEvidenceRefs(value, refs);
  return [...refs].sort((left, right) => left.localeCompare(right));
}

function collectSemanticEvidenceRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSemanticEvidenceRefs(item, refs));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const file = typeof value.file === "string" ? value.file : undefined;
  const line = typeof value.line === "number" ? value.line : undefined;
  const column = typeof value.column === "number" ? value.column : undefined;
  const name = typeof value.name === "string" ? value.name : typeof value.symbol === "string" ? value.symbol : undefined;
  if (file) {
    refs.add(`${file}${line !== undefined ? `:${line}${column !== undefined ? `:${column}` : ""}` : ""}${name ? `#${name}` : ""}`);
  }
  for (const item of Object.values(value)) {
    collectSemanticEvidenceRefs(item, refs);
  }
}

function semanticEvidenceSymbol(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const symbol = semanticEvidenceSymbol(item);
      if (symbol) {
        return symbol;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = stringField(value.symbol)
    ?? stringField(value.name)
    ?? stringField(value.displayName)
    ?? stringField(value.fullDisplayName);
  if (direct) {
    return direct;
  }
  for (const item of Object.values(value)) {
    const symbol = semanticEvidenceSymbol(item);
    if (symbol) {
      return symbol;
    }
  }
  return undefined;
}

function semanticEvidenceRange(value: unknown): LspRange | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const range = semanticEvidenceRange(item);
      if (range) {
        return range;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const directRange = lspRangeFromUnknown(value.range ?? value.triggerSpan);
  if (directRange) {
    return directRange;
  }
  const line = numberField(value.line);
  const column = numberField(value.column);
  if (line !== undefined && column !== undefined) {
    return {
      start: { line, column },
      end: {
        line: numberField(value.endLine) ?? line,
        column: numberField(value.endColumn) ?? column
      }
    };
  }
  for (const item of Object.values(value)) {
    const range = semanticEvidenceRange(item);
    if (range) {
      return range;
    }
  }
  return undefined;
}

function lspRangeFromUnknown(value: unknown): LspRange | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = isRecord(value.start) ? value.start : undefined;
  const end = isRecord(value.end) ? value.end : undefined;
  const startLine = numberField(start?.line);
  const startColumn = numberField(start?.column);
  const endLine = numberField(end?.line);
  const endColumn = numberField(end?.column);
  if (startLine === undefined || startColumn === undefined || endLine === undefined || endColumn === undefined) {
    return undefined;
  }
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn }
  };
}

function semanticEvidenceChangedFiles(value: unknown): string[] | undefined {
  const files = new Set<string>();
  collectChangedFiles(value, files);
  const result = [...files].sort((left, right) => left.localeCompare(right));
  return result.length ? result : undefined;
}

function collectChangedFiles(value: unknown, files: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectChangedFiles(item, files));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (Array.isArray(value.affectedFiles)) {
    value.affectedFiles
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .forEach((item) => files.add(item));
  }
  const directFile = stringField(value.file);
  const oldText = stringField(value.oldText);
  const newText = stringField(value.newText);
  if (directFile && (oldText !== undefined || newText !== undefined)) {
    files.add(directFile);
  }
  for (const item of Object.values(value)) {
    collectChangedFiles(item, files);
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function semanticEvidenceId(value: Record<string, unknown>): string {
  const hash = createHash("sha1").update(JSON.stringify(sortJsonValue(value))).digest("hex").slice(0, 12);
  return `sem:${hash}`;
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortJsonValue(value[key])])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
