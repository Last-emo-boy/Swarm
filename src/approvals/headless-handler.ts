import type { SwarmRuntime } from "../runtime/runtime.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import { delay } from "../server/gateway-client-utils.js";

export type HeadlessApprovalMode = "fail" | "wait";

export type HeadlessApprovalHandlerOptions = {
  runtime: SwarmRuntime;
  mode: HeadlessApprovalMode;
  workspace?: string;
  timeoutMs?: number;
  pollMs?: number;
  streamJsonOutput: boolean;
};

export function createHeadlessApprovalHandler(
  input: HeadlessApprovalHandlerOptions
): (request: ToolApprovalRequest) => Promise<boolean> {
  return async (request) => {
    if (input.mode !== "wait") {
      throw new Error([
        `Headless run requires approval for ${request.summary}.`,
        `action=${request.action} risk=${request.risk_class}/${request.risk} target=${request.target}`,
        `why=${request.why_now}`,
        "Re-run in the TUI, change permission mode, or pass --approval-mode wait and answer with `swarm approvals approve|deny <approval_id>`."
      ].join(" "));
    }

    const timeoutMs = input.timeoutMs ?? 10 * 60_000;
    const pollMs = input.pollMs ?? 1_000;
    const started = Date.now();
    const workspaceArg = input.workspace ? ` --workspace ${quoteCommandArg(input.workspace)}` : "";
    const command = `swarm approvals approve ${quoteCommandArg(request.id)}${workspaceArg}`;
    const denyCommand = `swarm approvals deny ${quoteCommandArg(request.id)}${workspaceArg}`;
    if (!input.streamJsonOutput) {
      console.error([
        `Headless approval pending: ${request.id}`,
        `${request.summary}`,
        `action=${request.action} risk=${request.risk_class}/${request.risk} target=${request.target}`,
        `Approve: ${command}`,
        `Deny: ${denyCommand}`
      ].join("\n"));
    }
    while (Date.now() - started < timeoutMs) {
      const record = input.runtime.approvalStore.get(request.id);
      if (record?.status === "approved") {
        return true;
      }
      if (record?.status === "denied") {
        return false;
      }
      await delay(pollMs);
    }
    throw new Error(`Timed out waiting for approval ${request.id}. Use \`${command}\` or \`${denyCommand}\` before retrying.`);
  };
}

function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}
