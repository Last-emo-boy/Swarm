import type { LocalToolContext, ToolResult } from "../tools/types.js";
import { runLspTool as runSemanticLspTool } from "./gateway.js";
import { runStdioLspTool, shouldUseStdioLsp } from "./stdio-tools.js";
import type { LspToolAction } from "./types.js";

export function runLspTool(action: LspToolAction, context: LocalToolContext): Promise<ToolResult> {
  return shouldUseStdioLsp(action)
    ? runStdioLspTool(action, context)
    : runSemanticLspTool(action, context);
}
