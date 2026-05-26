import React from "react";
import { Box, Text, resolveTuiRendererMode } from "../ui.js";
import type { ToolApprovalRequest } from "../../tools/types.js";
import { approvalInputDecision, type ApprovalInputKey } from "../approval-input.js";
import { shortcutHint } from "../shortcuts.js";
import { approvalRiskToken, compactValue, resolveTuiColor, sectionLabel, toneColor, visualTokenColor, type TuiColorRef } from "../theme.js";
import { StatusIcon } from "./StatusIcon.js";

export type ApprovalOverlayDecision = {
  approved: boolean;
  rememberForSession: boolean;
};

const OVERLAY_DIVIDER_WIDTH = 72;

export function ApprovalOverlay(props: {
  request: ToolApprovalRequest;
  onDecision?: (decision: ApprovalOverlayDecision) => void;
}): React.ReactElement {
  const request = props.request;
  const detailLines = request.detail.split(/\r?\n/).filter((line) => line.trim()).slice(0, 4);
  const previewLines = request.summary_diff?.split(/\r?\n/).slice(0, 6) ?? [];
  const attentionNote = request.attention_note
    ?? (request.risk === "shell" && request.risk_class === "r4"
      ? "Destructive shell command detected. Review the command literally before approving."
      : undefined);
  const riskToken = approvalRiskToken({ risk: request.risk, riskClass: request.risk_class });
  const reviewFocus = approvalReviewFocus(request);
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
  return (
    <Box {...rendererInputProps} flexDirection="column" paddingX={1} marginTop={1} width="100%">
      <ApprovalOverlayHeader tone={riskToken.tone} />
      <Text wrap="truncate">
        <StatusIcon status="pending" label="badge" withSpace />
        <Text color={resolveTuiColor("status.pending")} bold>{sectionLabel("Decision")} </Text>
        <Text color={visualTokenColor("text.muted")}>{shortcutHint(["approval.approve_once", "approval.allow_target", "approval.deny", "approval.cancel"])}</Text>
      </Text>
      <ApprovalRiskRow
        badge={riskToken.badge}
        label={riskToken.label}
        action={request.action}
        tone={riskToken.tone}
        target={request.target}
      />
      <ApprovalDetail label="Summary" value={request.summary} tone={riskToken.tone === "danger" ? "status.danger" : undefined} />
      {attentionNote ? <ApprovalDetail label="Attention" value={attentionNote} tone="status.danger" strong /> : null}
      <ApprovalDetail label="Review" value={reviewFocus} />
      <ApprovalDetail label="Why" value={request.why_now} />
      {request.permission_reason ? (
        <ApprovalDetail
          label="Permission"
          value={`${request.permission_name ?? request.action} ${request.permission_decision ?? "ask"} | ${request.permission_reason}`}
        />
      ) : null}
      {request.permission_rule ? (
        <ApprovalDetail label="Rule" value={request.permission_rule} muted />
      ) : null}
      {request.governance ? (
        <ApprovalDetail
          label="Governance"
          value={`actor=${request.governance.actor_binding.actor_id} scope=${request.governance.scope.target} ttl=${request.governance.ttl_ms}ms expires=${request.governance.expires_at}`}
          muted
        />
      ) : null}
      <ApprovalDetail label="Impact" value={request.predicted_impact} tone={riskToken.tone === "danger" ? "status.danger" : undefined} />
      <ApprovalDetail label="Rollback" value={request.rollback_plan} />
      {detailLines.map((line, index) => (
        <Text key={`${index}-${line}`} color={visualTokenColor("text.muted")} wrap="truncate">  {line}</Text>
      ))}
      {previewLines.length ? (
        <Box flexDirection="column">
          <Text wrap="truncate">
            <Text color={visualTokenColor("role.tool")} bold>{sectionLabel("Preview")}</Text>
            <Text color={visualTokenColor("text.muted")}> {"─".repeat(72)}</Text>
          </Text>
          {previewLines.map((line, index) => (
            <Text key={`${index}-${line}`} wrap="truncate">{line}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function ApprovalOverlayHeader({ tone }: { tone: ReturnType<typeof approvalRiskToken>["tone"] }): React.ReactElement {
  return (
    <Text color={toneColor(tone)} wrap="truncate">
      {"─".repeat(OVERLAY_DIVIDER_WIDTH)}
    </Text>
  );
}

function ApprovalRiskRow(props: {
  badge: string;
  label: string;
  action: string;
  tone: ReturnType<typeof approvalRiskToken>["tone"];
  target: string;
}): React.ReactElement {
  return (
    <Text wrap="truncate">
      <Text color={toneColor(props.tone)} bold>{props.badge} {props.label}</Text>
      <Text color={visualTokenColor("text.primary")}> {props.action}</Text>
      <Text color={visualTokenColor("text.muted")}> · </Text>
      <Text color={visualTokenColor("role.gateway")}>{sectionLabel("Target")} </Text>
      <Text color={visualTokenColor("text.primary")}>{compactValue(props.target, 96)}</Text>
    </Text>
  );
}

function ApprovalDetail(props: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: TuiColorRef;
  strong?: boolean;
}): React.ReactElement {
  return (
    <Text wrap="wrap">
      <Text color={visualTokenColor("text.muted")}>{sectionLabel(props.label)} </Text>
      <Text color={resolveTuiColor(props.tone ?? (props.muted ? "text.muted" : undefined))} bold={props.strong}>{props.value}</Text>
    </Text>
  );
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
