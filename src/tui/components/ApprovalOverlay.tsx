import React from "react";
import { Box, Text, resolveTuiRendererMode } from "../ui.js";
import type { ToolApprovalRequest } from "../../tools/types.js";
import { approvalInputDecision, type ApprovalInputKey } from "../approval-input.js";
import { approvalRiskToken, compactValue, visualTokenColor, type TuiVisualToken } from "../theme.js";

export type ApprovalOverlayDecision = {
  approved: boolean;
  rememberForSession: boolean;
};

/** Diff lines an edit shows before `?`: enough to see the change, not so many that the transcript disappears. */
const DIFF_PREVIEW_LINES = 8;
const KEYS = "y yes · a always · n no · ? details";

/**
 * The approval card in place of the prompt: what the call does and to what, why it was asked, and the keys. Edits show
 * the first lines of their diff; a high-risk call says so in red. `?` opens everything else the request carries inside
 * the card (risk class, review focus, governance, impact, rollback). `a` (or `s`) allows the same target for the rest
 * of the session.
 */
export function ApprovalOverlay(props: {
  request: ToolApprovalRequest;
  onDecision?: (decision: ApprovalOverlayDecision) => void;
  /** Show the full request, as `?` does. */
  expanded?: boolean;
  /** Rows the card may take; the expanded detail is cut to fit. */
  maxRows?: number;
}): React.ReactElement {
  const request = props.request;
  const card = approvalCardModel(request);
  const rendererInputProps = resolveTuiRendererMode() === "dom-renderer" && props.onDecision
    ? ({
      focusable: true,
      onKeydown: (event: { input?: string; key?: ApprovalInputKey; preventDefault: () => void }) => {
        const decision = approvalInputDecision(event.input ?? "", event.key ?? {});
        if (!decision.handled) {
          return;
        }
        event.preventDefault();
        props.onDecision?.({
          approved: decision.approved,
          rememberForSession: decision.rememberForSession
        });
      }
    } as never)
    : {};
  const detailRows = props.expanded
    ? approvalDetailLines(request).slice(0, Math.max(0, (props.maxRows ?? Number.POSITIVE_INFINITY) - (approvalCardRows(request) - card.diff.length)))
    : [];
  return (
    <Box {...rendererInputProps} flexDirection="column" width="100%" flexShrink={0}>
      <Box
        flexDirection="column"
        paddingX={1}
        width="100%"
        borderStyle="single"
        borderColor={visualTokenColor(card.high ? "status.danger" : "status.pending")}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text wrap="truncate">
          <Text color={visualTokenColor(card.high ? "status.danger" : "status.pending")} bold>{card.high ? "! " : "? "}</Text>
          <Text color={visualTokenColor("text.primary")} bold>{card.title}</Text>
          {card.target ? <Text color={visualTokenColor("text.primary")}>{`  ${card.target}`}</Text> : null}
        </Text>
        {card.reason ? <Text color={visualTokenColor("text.muted")} wrap="truncate">{`  ${card.reason}`}</Text> : null}
        {card.attention ? <Text color={visualTokenColor("status.danger")} wrap="truncate">{`  ${card.attention}`}</Text> : null}
        {!props.expanded && card.diff.map((line, index) => (
          <Text key={`diff:${index}`} color={visualTokenColor(diffLineColor(line))} wrap="truncate">{`  ${line}`}</Text>
        ))}
        {detailRows.map((line, index) => (
          <Text key={`detail:${index}`} wrap="truncate">
            <Text color={visualTokenColor("text.muted")}>{`  ${line.label ? `${line.label} ` : ""}`}</Text>
            <Text color={visualTokenColor(line.tone ?? "text.primary")}>{line.value}</Text>
          </Text>
        ))}
        <Text color={visualTokenColor("text.muted")} wrap="truncate">{`  ${props.expanded ? KEYS.replace("? details", "? less") : KEYS}`}</Text>
      </Box>
    </Box>
  );
}

/** Rows the folded card takes: the rule, the title, the reason and attention when there are any, the diff, the keys. */
export function approvalCardRows(request: ToolApprovalRequest): number {
  const card = approvalCardModel(request);
  return 3 + (card.reason ? 1 : 0) + (card.attention ? 1 : 0) + card.diff.length;
}

/** Rows the card takes with `?` open, before the room it is given cuts it. */
export function approvalExpandedRows(request: ToolApprovalRequest): number {
  const card = approvalCardModel(request);
  return approvalCardRows(request) - card.diff.length + approvalDetailLines(request).length;
}

type ApprovalCardModel = {
  title: string;
  target: string;
  reason: string;
  attention?: string;
  high: boolean;
  diff: string[];
};

function approvalCardModel(request: ToolApprovalRequest): ApprovalCardModel {
  const high = request.risk_class === "r4";
  const attention = request.attention_note
    ?? (request.risk === "shell" && high
      ? "Destructive shell command detected. Review the command literally before approving."
      : undefined);
  const cwd = /^(?:CWD|cwd)\s*[:=]\s*(.+)$/mu.exec(request.detail)?.[1]?.trim();
  const reason = [
    request.permission_rule ? `rule ${request.permission_rule}` : request.permission_reason ?? "",
    cwd && cwd !== "." ? `in ${cwd}` : ""
  ].filter(Boolean).join(" · ");
  return {
    title: approvalTitle(request),
    target: compactValue(request.target, 96),
    reason,
    ...(attention ? { attention } : {}),
    high,
    // The file headers repeat the title's target.
    diff: request.summary_diff?.split(/\r?\n/u).filter((line) => line.length && !/^(---|\+\+\+) /u.test(line)).slice(0, DIFF_PREVIEW_LINES) ?? []
  };
}

/** What the call does, in words: "Run a command", "Edit a file", "Fetch a page". */
export function approvalTitle(request: Pick<ToolApprovalRequest, "action" | "risk">): string {
  const action = String(request.action);
  const titles: Record<string, string> = {
    "shell.exec": "Run a command", exec: "Run a command", Bash: "Run a command", "process.start": "Start a process",
    "code.test": "Run the tests", "code.lint": "Run the linter", "code.build": "Run the build",
    "file.write": "Write a file", Write: "Write a file",
    "file.edit": "Edit a file", "file.patch": "Edit a file", Edit: "Edit a file", "json.edit": "Edit a file", "notebook.edit": "Edit a notebook",
    "file.delete": "Delete a file", "file.move": "Move a file", "file.copy": "Copy a file", "file.mkdir": "Create a folder",
    "web.fetch": "Fetch a page", WebFetch: "Fetch a page", "web.search": "Search the web", WebSearch: "Search the web",
    "agent.delegate": "Delegate to an agent", "package.install": "Install packages"
  };
  if (titles[action]) {
    return titles[action]!;
  }
  if (action.startsWith("git.")) {
    return `Run git ${action.slice(4)}`;
  }
  return { write: "Change files", shell: "Run a command", web: "Use the network", install: "Install packages", delegate: "Delegate to an agent" }[request.risk];
}

type ApprovalDetailLine = { label: string; value: string; tone?: TuiVisualToken };

/** Everything the request carries, one line each, for `?`. */
function approvalDetailLines(request: ToolApprovalRequest): ApprovalDetailLine[] {
  const risk = approvalRiskToken({ risk: request.risk, riskClass: request.risk_class });
  const danger = risk.tone === "danger" ? "status.danger" : undefined;
  const lines: ApprovalDetailLine[] = [
    { label: "Risk", value: `${risk.badge} ${risk.label} ${request.action}`, tone: danger },
    { label: "Summary", value: request.summary, tone: danger },
    { label: "Review focus:", value: approvalReviewFocus(request) },
    { label: "Why now", value: request.why_now }
  ];
  if (request.permission_reason) {
    lines.push({ label: "Permission:", value: `${request.permission_name ?? request.action} ${request.permission_decision ?? "ask"} | ${request.permission_reason}` });
  }
  if (request.governance) {
    lines.push({
      label: "Governance",
      value: `actor=${request.governance.actor_binding.actor_id} scope=${request.governance.scope.target} ttl=${request.governance.ttl_ms}ms expires=${request.governance.expires_at}`,
      tone: "text.muted"
    });
  }
  lines.push(
    { label: "Impact", value: request.predicted_impact, tone: danger },
    { label: "Rollback", value: request.rollback_plan },
    { label: "a always", value: "allows this target for the rest of the session", tone: "text.muted" },
    ...request.detail.split(/\r?\n/u).filter((line) => line.trim()).slice(0, 6).map((line) => ({ label: "", value: line, tone: "text.muted" as const })),
    ...(request.summary_diff?.split(/\r?\n/u).filter((line) => line.length) ?? []).map((line) => ({ label: "", value: line, tone: diffLineColor(line) }))
  );
  return lines.filter((line) => line.value.trim());
}

function diffLineColor(line: string): TuiVisualToken {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "diff.added";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "diff.removed";
  }
  return "text.muted";
}

function approvalReviewFocus(request: ToolApprovalRequest): string {
  if (request.risk_class === "r4") {
    return "high-risk operation; verify target, command text, and rollback before approving";
  }
  if (request.risk === "shell") {
    return "shell command; check cwd assumptions, chained commands, and generated file paths";
  }
  if (request.risk === "write") {
    return "workspace write; check file scope, expected diff, and whether the change is reversible";
  }
  if (request.risk === "delegate") {
    return "worker delegation; check write policy, file scope, and whether the task needs a worker";
  }
  if (request.risk === "web") {
    return "network access; check destination, data exposure, and retry cost";
  }
  if (request.risk === "install") {
    return "dependency or installer action; check package source and postinstall behavior";
  }
  return "review the target, impact, and rollback plan before approving";
}
