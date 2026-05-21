import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { displayPath, resolveReadablePath } from "../tools/permissions.js";
import type { LocalToolContext, ToolResult } from "../tools/types.js";
import { getGlobalLspManager, pathFromLspUri, type LspPosition, type LspRange as ManagerLspRange } from "./manager.js";
import type { LspRange as ToolLspRange, LspToolAction } from "./types.js";

export async function runStdioLspTool(action: LspToolAction, context: LocalToolContext): Promise<ToolResult> {
  try {
    return await executeStdioLspTool(action, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      action: action.type,
      status: "failed",
      summary: `LSP ${action.type.replace("lsp.", "")} failed: ${firstLine(message)}`,
      errors: [message],
      errorCode: /unavailable|Command not found|No LSP provider/i.test(message) ? "LSP_UNAVAILABLE" : "LSP_FAILED",
      recoverable: true,
      retryable: /timed out|exited|not running/i.test(message),
      recoverySuggestion: "Configure the matching SWARM_LSP_*_COMMAND or use file.read/file.grep as a fallback."
    };
  }
}

async function executeStdioLspTool(action: LspToolAction, context: LocalToolContext): Promise<ToolResult> {
  if (action.type === "lsp.workspace_symbols") {
    const root = action.root ? resolveReadablePath(action.root, context) : context.workspace;
    const result = await getGlobalLspManager(root).workspaceSymbols({
      query: action.query ?? "",
      timeoutMs: action.timeoutMs,
      providerId: action.provider
    });
    const symbols = flattenSymbols(asArray(result)).slice(0, limit(action));
    return toolResult(action.type, symbols.length ? `LSP workspace symbols returned ${symbols.length} item(s).` : "LSP workspace symbols returned no items.", symbols.map((symbol) => formatSymbol(symbol, context.workspace)).join("\n") || "(empty)", result);
  }

  const document = await readDocument(action, context);
  const manager = getGlobalLspManager(action.root ? resolveReadablePath(action.root, context) : context.workspace);
  const base = { path: document.path, text: document.text, timeoutMs: action.timeoutMs, providerId: action.provider };

  if (action.type === "lsp.diagnostics") {
    const result = await manager.diagnostics({ ...base, timeoutMs: action.diagnosticsTimeoutMs ?? action.timeoutMs });
    const diagnostics = asArray(result);
    return toolResult(action.type, diagnostics.length ? `LSP diagnostics returned ${diagnostics.length} item(s).` : "LSP diagnostics returned no items.", formatDiagnostics(diagnostics), result, document.display);
  }
  if (action.type === "lsp.hover") {
    const result = await manager.hover({ ...base, position: position(action) });
    const content = hoverText(result);
    return toolResult(action.type, content ? "LSP hover returned content." : "LSP hover returned no content.", content || "(empty)", result, document.display);
  }
  if (action.type === "lsp.definition") {
    const result = await manager.definition({ ...base, position: position(action) });
    const definitionLocations = locations(result);
    return toolResult(action.type, definitionLocations.length ? `LSP definition returned ${definitionLocations.length} location(s).` : "LSP definition returned no locations.", formatLocations(definitionLocations, context.workspace), result, document.display);
  }
  if (action.type === "lsp.references") {
    const result = await manager.references({ ...base, position: position(action), includeDeclaration: action.includeDeclaration });
    const refs = locations(result);
    return toolResult(action.type, refs.length ? `LSP references returned ${refs.length} location(s).` : "LSP references returned no locations.", formatLocations(refs, context.workspace), result, document.display);
  }
  if (action.type === "lsp.document_symbols") {
    const result = await manager.documentSymbols(base);
    const symbols = flattenSymbols(asArray(result)).slice(0, limit(action));
    return toolResult(action.type, symbols.length ? `LSP document symbols returned ${symbols.length} item(s).` : "LSP document symbols returned no items.", symbols.map((symbol) => `${symbol.name}${symbol.range ? ` ${formatRange(symbol.range)}` : ""}`).join("\n") || "(empty)", result, document.display);
  }
  if (action.type === "lsp.completion") {
    const result = await manager.completion({ ...base, position: position(action), triggerCharacter: action.triggerCharacter });
    const items = completionItems(result).slice(0, limit(action));
    return toolResult(action.type, items.length ? `LSP completion returned ${items.length} item(s).` : "LSP completion returned no items.", items.map(formatCompletion).join("\n") || "(empty)", result, document.display);
  }
  if (action.type === "lsp.code_actions") {
    const result = await manager.codeActions({ ...base, range: range(action) });
    const items = asArray(result).slice(0, limit(action));
    return toolResult(action.type, items.length ? `LSP code actions returned ${items.length} item(s).` : "LSP code actions returned no items.", items.map((item) => String(asRecord(item).title ?? "")).filter(Boolean).join("\n") || "(empty)", result, document.display);
  }
  if (action.type === "lsp.rename_preview") {
    const result = await manager.renamePreview({ ...base, position: position(action), newName: action.newName });
    const edits = workspaceEditCount(result);
    return toolResult(action.type, edits ? `LSP rename preview returned ${edits} edit(s).` : "LSP rename preview returned no edits.", formatWorkspaceEdit(result, context.workspace), result, document.display);
  }
  const result = await manager.format(base);
  const edits = asArray(result).length;
  return toolResult(action.type, edits ? `LSP format returned ${edits} text edit(s).` : "LSP format returned no edits.", edits ? JSON.stringify(result, null, 2) : "(empty)", result, document.display);
}

export function shouldUseStdioLsp(action: LspToolAction): boolean {
  const provider = action.provider;
  const configured = Boolean(process.env.SWARM_LSP_TYPESCRIPT_COMMAND?.trim())
    || Boolean(process.env.SWARM_LSP_PYTHON_COMMAND?.trim())
    || Boolean(process.env.SWARM_LSP_RUST_COMMAND?.trim())
    || Boolean(process.env.SWARM_LSP_GO_COMMAND?.trim());
  if (configured) {
    return true;
  }
  return Boolean(provider && provider !== "typescript" && provider !== "typescript-language-service");
}

async function readDocument(action: LspToolAction, context: LocalToolContext): Promise<{ path: string; display: string; text: string }> {
  const requested = "file" in action && action.file ? action.file : "path" in action ? action.path : undefined;
  if (!requested) {
    throw new Error(`${action.type} requires file or path.`);
  }
  const path = resolveReadablePath(requested, context);
  return {
    path,
    display: displayPath(path, context.workspace),
    text: await readFile(path, "utf8")
  };
}

function position(action: { line?: number; lineZeroBased?: number; character?: number; column?: number }): LspPosition {
  return {
    line: Math.max(0, Math.floor(action.lineZeroBased ?? ((action.line ?? 1) - 1))),
    character: Math.max(0, Math.floor(action.character ?? ((action.column ?? 1) - 1)))
  };
}

function range(action: { range?: ToolLspRange; startLine?: number; startCharacter?: number; endLine?: number; endCharacter?: number; line?: number; character?: number; column?: number }): ManagerLspRange {
  if (action.range) {
    return {
      start: { line: Math.max(0, action.range.start.line - 1), character: Math.max(0, action.range.start.column - 1) },
      end: { line: Math.max(0, action.range.end.line - 1), character: Math.max(0, action.range.end.column - 1) }
    };
  }
  const startLine = action.startLine ?? action.line ?? 1;
  const endLine = action.endLine ?? startLine;
  return {
    start: { line: Math.max(0, startLine - 1), character: Math.max(0, action.startCharacter ?? action.character ?? ((action.column ?? 1) - 1)) },
    end: { line: Math.max(0, endLine - 1), character: Math.max(0, action.endCharacter ?? action.startCharacter ?? action.character ?? ((action.column ?? 1) - 1)) }
  };
}

function toolResult(action: string, summary: string, content: string, data: unknown, path?: string): ToolResult {
  return {
    action,
    status: "success",
    summary,
    content,
    data,
    metadata: path ? { path } : undefined
  };
}

function formatDiagnostics(items: unknown[]): string {
  return items.length ? items.map((item) => {
    const record = asRecord(item);
    const severity = record.severity === 1 ? "error" : record.severity === 2 ? "warning" : "diagnostic";
    return `${severity} ${record.source ?? ""} ${record.message ?? ""}`.trim();
  }).join("\n") : "(empty)";
}

function hoverText(result: unknown): string {
  const contents = asRecord(result).contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markedText).filter(Boolean).join("\n\n");
  return markedText(contents);
}

function markedText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return typeof record.value === "string" ? record.value : "";
}

function locations(result: unknown): Array<{ path: string; range?: Record<string, unknown> }> {
  const items: Array<{ path: string; range?: Record<string, unknown> }> = [];
  for (const item of asArray(result)) {
    const record = asRecord(item);
    const uri = typeof record.uri === "string" ? record.uri : typeof record.targetUri === "string" ? record.targetUri : "";
    if (uri) {
      items.push({ path: pathFromLspUri(uri), range: asRecord(record.range) || asRecord(record.targetSelectionRange) });
    }
  }
  return items;
}

function formatLocations(items: Array<{ path: string; range?: Record<string, unknown> }>, workspace: string): string {
  return items.length ? items.map((item) => `${relativePath(item.path, workspace)}${item.range ? ` ${formatRange(item.range)}` : ""}`).join("\n") : "(empty)";
}

function flattenSymbols(items: unknown[]): Array<{ name: string; range?: Record<string, unknown>; location?: { path: string; range?: Record<string, unknown> } }> {
  const result: Array<{ name: string; range?: Record<string, unknown>; location?: { path: string; range?: Record<string, unknown> } }> = [];
  const visit = (item: unknown) => {
    const record = asRecord(item);
    if (typeof record.name === "string") {
      const location = asRecord(record.location);
      const uri = typeof location.uri === "string" ? location.uri : "";
      result.push({
        name: record.name,
        range: asRecord(record.range) || asRecord(location.range),
        location: uri ? { path: pathFromLspUri(uri), range: asRecord(location.range) } : undefined
      });
    }
    for (const child of asArray(record.children)) visit(child);
  };
  for (const item of items) visit(item);
  return result;
}

function formatSymbol(symbol: { name: string; location?: { path: string; range?: Record<string, unknown> } }, workspace: string): string {
  return `${symbol.name}${symbol.location ? ` ${relativePath(symbol.location.path, workspace)}` : ""}`;
}

function completionItems(result: unknown): unknown[] {
  return Array.isArray(result) ? result : asArray(asRecord(result).items);
}

function formatCompletion(item: unknown): string {
  const record = asRecord(item);
  return [record.label, record.detail].filter(Boolean).map(String).join(" ");
}

function workspaceEditCount(value: unknown): number {
  const record = asRecord(value);
  const changes = asRecord(record.changes);
  let count = 0;
  for (const edits of Object.values(changes)) {
    count += asArray(edits).length;
  }
  for (const change of asArray(record.documentChanges)) {
    count += asArray(asRecord(change).edits).length;
  }
  return count;
}

function formatWorkspaceEdit(value: unknown, workspace: string): string {
  const record = asRecord(value);
  const changes = asRecord(record.changes);
  const lines = Object.entries(changes).map(([uri, edits]) => `${relativePath(pathFromLspUri(uri), workspace)} edits=${asArray(edits).length}`);
  return lines.length ? lines.join("\n") : "(empty)";
}

function formatRange(range: Record<string, unknown>): string {
  const start = asRecord(range.start);
  const line = typeof start.line === "number" ? start.line + 1 : "?";
  const character = typeof start.character === "number" ? start.character : "?";
  return `${line}:${character}`;
}

function limit(action: { maxItems?: number; maxResults?: number }): number {
  return Math.max(1, Math.min(action.maxItems ?? action.maxResults ?? 50, 250));
}

function relativePath(path: string, workspace: string): string {
  const value = relative(workspace, path).replace(/\\/g, "/");
  return value && !value.startsWith("..") ? value : path;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? value;
}
