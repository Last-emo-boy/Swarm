import React from "react";
import { Box, Text } from "ink";
import type { ToolApprovalRequest } from "../../tools/types.js";
import { sectionLabel, statusBadge } from "../theme.js";

export function ApprovalOverlay(props: { request: ToolApprovalRequest }): React.ReactElement {
  const request = props.request;
  const detailLines = request.detail.split(/\r?\n/).filter((line) => line.trim()).slice(0, 4);
  const previewLines = request.summary_diff?.split(/\r?\n/).slice(0, 6) ?? [];
  const attentionNote = request.attention_note
    ?? (request.risk === "shell" && request.risk_class === "r4"
      ? "Destructive shell command detected. Review the command literally before approving."
      : undefined);
  const riskColor = request.risk === "shell" || request.risk_class === "r4" ? "red" : "yellow";
  const reviewFocus = approvalReviewFocus(request);
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginTop={1} width="100%">
      <Text color="yellow" bold>{statusBadge("pending")} {sectionLabel("Approval Required")} <Text color="gray">for {request.action}</Text></Text>
      <Text color={riskColor} wrap="truncate">
        {request.summary} [{request.risk_class}/{request.risk}]
      </Text>
      {attentionNote ? <Text color="red" bold wrap="truncate">{attentionNote}</Text> : null}
      <Text color="cyan" bold>{sectionLabel("Decision Menu")}</Text>
      <Text color="gray" wrap="truncate">Y approve once | S allow same target this session | N deny | Esc cancel</Text>
      <Text wrap="truncate">Target: {request.target}</Text>
      <Text wrap="truncate">Review focus: {reviewFocus}</Text>
      <Text wrap="truncate">Why now: {request.why_now}</Text>
      {request.permission_reason ? (
        <Text wrap="truncate">Permission: {request.permission_name ?? request.action} {request.permission_decision ?? "ask"} | {request.permission_reason}</Text>
      ) : null}
      {request.permission_rule ? (
        <Text color="gray" wrap="truncate">Rule: {request.permission_rule}</Text>
      ) : null}
      <Text wrap="truncate">Impact: {request.predicted_impact}</Text>
      <Text wrap="truncate">Rollback: {request.rollback_plan}</Text>
      {detailLines.map((line, index) => (
        <Text key={`${index}-${line}`} wrap="truncate">{line}</Text>
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
