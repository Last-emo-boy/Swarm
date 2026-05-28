import React from "react";
import { Box, Text } from "../ui.js";
import { visualTokenColor } from "../theme.js";
import { SemanticTextLine } from "../components/SemanticTextLine.js";
import type { ResultPreview as ResultPreviewData, RunBoardResultAction } from "./run-board-types.js";
import { RunBoardPanel } from "./RunBoardSurface.js";

export function ResultPreview(props: {
  preview: ResultPreviewData;
  onAction?: (action: RunBoardResultAction) => void;
}): React.ReactElement {
  const preview = props.preview;
  const actions = preview.nextActions.slice(0, 3).map((command) => ({
    command,
    label: command,
    source: "preview" as const
  }));
  return (
    <RunBoardPanel title="Result Preview">
      <SemanticTextLine wrap="truncate" spans={[
        { text: preview.status, color: preview.status === "failed" ? "status.danger" : preview.status === "blocked" ? "status.warning" : "text.muted", bold: true },
        { text: " ", color: "text.muted" },
        { text: preview.summary, color: "text.primary" }
      ]} />
      {preview.hypothesis ? <PreviewLine label="Hypothesis" value={preview.hypothesis} /> : null}
      {preview.changedFiles.length ? <PreviewLine label="Changed" value={preview.changedFiles.slice(0, 3).join(", ")} /> : null}
      {preview.checks.length ? (
        <PreviewLine
          label="Checks"
          value={preview.checks.slice(0, 3).map((check) => `${check.command} [${check.status}]`).join(", ")}
        />
      ) : null}
      {preview.blockers.length ? <PreviewLine label="Blockers" value={preview.blockers.slice(0, 2).join(", ")} /> : null}
      {preview.artifacts.length ? <PreviewLine label="Artifacts" value={preview.artifacts.slice(0, 2).join(", ")} /> : null}
      <PreviewLine label="Confidence" value={preview.confidence} />
      {preview.contributors.length ? (
        <PreviewLine
          label="Contributors"
          value={preview.contributors.slice(0, 3).map((contributor) => `${contributor.label}: ${contributor.contribution}`).join(", ")}
        />
      ) : null}
      {actions.length ? <ResultActions actions={actions} onAction={props.onAction} /> : null}
    </RunBoardPanel>
  );
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
