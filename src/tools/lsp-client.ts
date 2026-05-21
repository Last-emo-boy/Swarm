import { runLspTool as runGatewayLspTool } from "../lsp/gateway.js";
import { disposeGlobalLspManager } from "../lsp/manager.js";
import type { LspToolAction } from "../lsp/types.js";
import type { LocalToolContext, ToolAction, ToolResult } from "./types.js";

const LSP_ACTION_TYPES = new Set([
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
]);

export function isLspToolAction(action: ToolAction): action is LspToolAction {
  return LSP_ACTION_TYPES.has(action.type);
}

export async function runLspTool(action: LspToolAction, context: LocalToolContext): Promise<ToolResult> {
  return runGatewayLspTool(action, context);
}

export async function disposeLspClients(): Promise<void> {
  await disposeGlobalLspManager();
}
