import type { PermissionMode, SwarmSettings } from "../config/settings.js";
import type { ApprovalRecord } from "../storage/approval-store.js";
import { displayPath } from "../tools/permissions.js";
import type { RunSandboxMode } from "./execution-router.js";

export type PermissionReportInput = {
  permissions: SwarmSettings["permissions"];
  sandboxMode?: RunSandboxMode;
  workspace?: string;
  recentApprovals?: ApprovalRecord[];
};

export type PermissionReport = {
  brief: string;
  detail: string;
};

export function buildPermissionReport(input: PermissionReportInput): PermissionReport {
  const workspace = input.workspace ?? process.cwd();
  const mode = effectivePermissionMode(input.permissions.defaultMode);
  const sandboxMode = input.sandboxMode ?? "workspace-write";
  const recentApprovals = input.recentApprovals ?? [];
  const pending = recentApprovals.filter((approval) => approval.status === "pending").length;
  const approved = recentApprovals.filter((approval) => approval.status === "approved").length;
  const denied = recentApprovals.filter((approval) => approval.status === "denied").length;
  const additionalDirectories = [...input.permissions.additionalDirectories];
  const brief = [
    `Permissions: ${mode}.`,
    `Sandbox: ${sandboxMode}.`,
    `Rules allow=${input.permissions.allow.length} ask=${input.permissions.ask.length} deny=${input.permissions.deny.length}.`,
    `Approvals pending=${pending} approved=${approved} denied=${denied}.`
  ].join(" ");
  const detail = [
    `Permission mode: ${mode}${input.permissions.defaultMode !== mode ? ` (configured as ${input.permissions.defaultMode})` : ""}`,
    `Sandbox: ${sandboxMode}`,
    `Rules: allow=${input.permissions.allow.length} ask=${input.permissions.ask.length} deny=${input.permissions.deny.length}`,
    `Read roots: workspace + ${additionalDirectories.length} additional`,
    "",
    "Mode defaults",
    ...modeDefaultLines(mode),
    "",
    "Rule precedence",
    "- deny rules are checked first and always win.",
    "- allow rules bypass mode defaults, including ask-mode prompts and the destructive-shell guard.",
    "- custom ask rules override mode defaults, including full-auto and yolo bypasses.",
    "- baseline ask catalog entries do not cancel full-auto or yolo by themselves.",
    "- full-auto and yolo still ask for r4 destructive shell actions unless explicitly allowed.",
    "- read-only and low-risk actions stay allowed unless a deny rule matches.",
    "",
    "Sandbox behavior",
    ...sandboxModeLines(sandboxMode),
    "",
    "Read roots",
    `- workspace: ${workspace}`,
    ...(additionalDirectories.length
      ? additionalDirectories.map((directory) => `- additional: ${displayPath(directory, workspace)}`)
      : ["- additional: none"]),
    "",
    ...renderRuleSection("Allow rules", input.permissions.allow),
    "",
    ...renderRuleSection("Ask rules", input.permissions.ask),
    "",
    ...renderRuleSection("Deny rules", input.permissions.deny),
    "",
    "Recent approvals",
    `- summary: pending=${pending} approved=${approved} denied=${denied}`,
    ...(recentApprovals.length ? recentApprovals.slice(0, 5).map(formatApprovalLine) : ["- none recorded for this workspace"])
  ].join("\n");
  return { brief, detail };
}

function effectivePermissionMode(mode: SwarmSettings["permissions"]["defaultMode"]): PermissionMode {
  if (mode === "yolo") {
    return "yolo";
  }
  if (mode === "full-auto" || mode === "auto") {
    return "full-auto";
  }
  if (mode === "auto-edit") {
    return "auto-edit";
  }
  return "ask";
}

function modeDefaultLines(mode: PermissionMode): string[] {
  if (mode === "ask") {
    return [
      "- ask: edits, shell, exec, delegate, fetch, and branch changes ask for approval.",
      "- ask: low-risk reads stay allowed unless a deny rule matches."
    ];
  }
  if (mode === "auto-edit") {
    return [
      "- auto-edit: file edits and other write-like actions auto-allow inside the workspace.",
      "- auto-edit: shell, exec, package install, delegate, and branch changes still ask."
    ];
  }
  if (mode === "full-auto") {
    return [
      "- full-auto: edits, shell, exec, package install, delegate, fetch, and branch changes auto-allow.",
      "- full-auto: r4 destructive shell actions still stop for approval unless explicitly allowed."
    ];
  }
  return [
    "- yolo: same fast path as full-auto, with approval prompts bypassed for normal actions.",
    "- yolo: custom ask rules and r4 destructive shell still stop for approval unless explicitly allowed."
  ];
}

function sandboxModeLines(mode: RunSandboxMode): string[] {
  if (mode === "read-only") {
    return [
      "- read-only: workspace writes, shell execution, package install, delegation, and durable mutations are denied at execution time.",
      "- read-only: read-only file, git inspection, process inspection, and bounded web tools still run."
    ];
  }
  return [
    "- workspace-write: workspace writes are allowed when the permission policy allows them.",
    "- workspace-write: writes outside the startup workspace stay denied."
  ];
}

function renderRuleSection(title: string, rules: string[]): string[] {
  return [title, ...(rules.length ? rules.map((rule) => `- ${rule}`) : ["- none"])];
}

function formatApprovalLine(approval: ApprovalRecord): string {
  const updatedAt = approval.updated_at.replace("T", " ").replace(".000Z", "Z");
  const summary = truncate(approval.summary, 96);
  const permissionRule = approval.challenge.permission_rule ? ` rule=${approval.challenge.permission_rule}` : "";
  return `- [${approval.status}/${approval.risk_class}] ${approval.action} target=${approval.target}${permissionRule} updated=${updatedAt} summary=${summary}`;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
