import React from "react";
import { Box, Text } from "../ui.js";
import { statusBadge, visualTokenColor } from "../theme.js";
import { SemanticTextLine } from "../components/SemanticTextLine.js";
import type { ResultPreview as ResultPreviewData, RunBoardResultAction } from "./run-board-types.js";
import { RunBoardPanel } from "./RunBoardSurface.js";
import { labelForRunBoardAction } from "./run-board-action-labels.js";

export function ResultPreview(props: {
  preview: ResultPreviewData;
  onAction?: (action: RunBoardResultAction) => void;
}): React.ReactElement {
  const preview = props.preview;
  const status = previewStatusLabel(preview.status);
  const blockers = visibleBlockers(preview);
  const actions = preview.nextActions.slice(0, 1).map((command) => ({
    command,
    label: labelForRunBoardAction(command),
    source: "preview" as const
  }));
  return (
    <RunBoardPanel title="Result">
      <SemanticTextLine wrap="truncate" spans={[
        ...(status ? [
          { text: status, color: preview.status === "failed" ? "status.danger" : preview.status === "blocked" ? "status.warning" : "text.muted", bold: true },
          { text: " ", color: "text.muted" }
        ] as const : []),
        { text: preview.summary, color: "text.primary" }
      ]} />
      {preview.changedFiles.length ? <PreviewLine label="Changed" value={preview.changedFiles.slice(0, 3).join(", ")} /> : null}
      {preview.checks.length ? (
        <PreviewLine
          label="Verified"
          value={preview.checks.slice(0, 3).map((check) => `${statusBadge(check.status)} ${check.command}`).join(", ")}
        />
      ) : null}
      {blockers.length ? <PreviewLine label="Blockers" value={blockers.slice(0, 2).join(", ")} /> : null}
      {actions.length ? <ResultActions actions={actions} onAction={props.onAction} /> : null}
    </RunBoardPanel>
  );
}

function visibleBlockers(preview: ResultPreviewData): string[] {
  const summary = preview.summary.toLowerCase();
  return preview.blockers.filter((blocker) => {
    const value = blocker.trim();
    return value && !summary.includes(value.toLowerCase());
  });
}

function previewStatusLabel(status: ResultPreviewData["status"]): string | undefined {
  switch (status) {
    case "empty": return undefined;
    case "pending": return "working";
    case "ready": return undefined;
    case "blocked": return "blocked";
    case "failed": return "failed";
  }
}

function PreviewLine(props: { label: string; value: string }): React.ReactElement {
  return (
    <SemanticTextLine wrap="truncate" spans={[
      { text: props.label, color: "text.muted", bold: true },
      { text: " ", color: "text.muted" },
      { text: props.value, color: "text.primary" }
    ]} />
  );
}

function ResultActions(props: {
  actions: RunBoardResultAction[];
  onAction?: (action: RunBoardResultAction) => void;
}): React.ReactElement {
  return (
    <Box flexDirection="row" width="100%">
      <Text color={visualTokenColor("text.muted")}>Next </Text>
      {props.actions.map((action, index) => (
        <Box
          key={`${action.source}:${action.command}`}
          flexDirection="row"
          marginLeft={index > 0 ? 2 : 0}
          focusable={Boolean(props.onAction)}
          onClick={props.onAction ? (() => props.onAction?.(action)) as never : undefined}
        >
          <Text color={visualTokenColor("brand.focus")} bold>{action.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
