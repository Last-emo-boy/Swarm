import React from "react";
import { Box, Text } from "ink";
import type { ToolApprovalRequest } from "../../tools/types.js";
import { approvalRiskToken, compactValue, sectionLabel, statusBadge, toneColor } from "../theme.js";

export function ApprovalOverlay(props: { request: ToolApprovalRequest }): React.ReactElement {
  const request = props.request;
  const detailLines = request.detail.split(/\r?\n/).filter((line) => line.trim()).slice(0, 4);
  const previewLines = request.summary_diff?.split(/\r?\n/).slice(0, 6) ?? [];
  const attentionNote = request.attention_note
    ?? (request.risk === "shell" && request.risk_class === "r4"
      ? "Destructive shell command detected. Review the command literally before approving."
      : undefined);
  const riskToken = approvalRiskToken({ risk: request.risk, riskClass: request.risk_class });
  const reviewFocus = approvalReviewFocus(request);
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={toneColor(riskToken.tone)} paddingX={1} marginTop={1} width="100%">
      <Text color="yellow" bold wrap="truncate">
        {statusBadge("pending")} {sectionLabel("Decision")} <Text color="gray">Y approve once | S allow target | N deny | Esc cancel</Text>
      </Text>
      <Text color={toneColor(riskToken.tone)} bold wrap="truncate">
        {riskToken.badge} {riskToken.label} {request.action}
      </Text>
      <Text wrap="wrap">
        <Text color="cyan">{sectionLabel("Target")} </Text>
        <Text>{compactValue(request.target, 140)}</Text>
      </Text>
      <Text color={toneColor(riskToken.tone)} wrap="wrap">
        {request.summary}
      </Text>
      {attentionNote ? <Text color="red" bold wrap="truncate">{attentionNote}</Text> : null}
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
      <ApprovalDetail label="Impact" value={request.predicted_impact} tone={riskToken.tone === "danger" ? "red" : undefined} />
      <ApprovalDetail label="Rollback" value={request.rollback_plan} />
      {detailLines.map((line, index) => (
        <Text key={`${index}-${line}`} color="gray" wrap="truncate">  {line}</Text>
      ))}
      {previewLines.length ? (
        <Box flexDirection="column">
          <Text color="cyan" bold>{sectionLabel("Preview")}</Text>
          {previewLines.map((line, index) => (
            <Text key={`${index}-${line}`} wrap="truncate">{line}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function ApprovalDetail(props: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: "red" | "yellow" | "cyan" | "gray";
}): React.ReactElement {
  return (
    <Text wrap="wrap">
      <Text color="cyan">{sectionLabel(props.label)} </Text>
      <Text color={props.tone ?? (props.muted ? "gray" : undefined)}>{props.value}</Text>
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
