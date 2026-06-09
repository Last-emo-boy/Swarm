import React from "react";
import { Box, Text } from "../ui.js";
import { sectionLabel, visualTokenColor } from "../theme.js";
import type { AttentionAction, AttentionItemView, RunBoardResultAction, RunBoardSurfaceView, WorkerBoardRow } from "./run-board-types.js";
import { WorkerBoard } from "./WorkerBoard.js";
import { AttentionPanel } from "./AttentionPanel.js";
import { ResultPreview } from "./ResultPreview.js";

export function RunBoardSurface(props: {
  view: RunBoardSurfaceView;
  workerLimit?: number;
  attentionLimit?: number;
  selectedRowId?: string;
  onWorkerClick?: (row: WorkerBoardRow) => void;
  onAttentionAction?: (item: AttentionItemView, action: AttentionAction) => void;
  onResultAction?: (action: RunBoardResultAction) => void;
}): React.ReactElement {
  const view = props.view;
  const showHeaderPanel = Boolean(view.objective) || shouldShowFocusLine(view);
  return (
    <Box flexDirection="column" width="100%">
      {showHeaderPanel ? (
        <RunBoardPanel title={view.title === "Swarm Board" ? "Work" : view.title}>
          {view.objective ? <HeaderObjectiveLine view={view} /> : null}
          {shouldShowFocusLine(view) ? <Text color={visualTokenColor("text.muted")} wrap="truncate">Focus      {view.focus}</Text> : null}
        </RunBoardPanel>
      ) : null}
      <WorkerBoard
        rows={view.workers}
        limit={props.workerLimit}
        selectedRowId={props.selectedRowId}
        onRowClick={props.onWorkerClick}
      />
      <AttentionPanel
        items={view.attention}
        limit={props.attentionLimit}
        onAction={props.onAttentionAction}
      />
      <ResultPreview preview={view.resultPreview} onAction={props.onResultAction} />
    </Box>
  );
}

export function RunBoardPanel(props: {
  title: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={visualTokenColor("surface.line")}
      paddingX={1}
    >
      <Text color={visualTokenColor("text.primary")} bold>{sectionLabel(props.title)}</Text>
      {props.children}
    </Box>
  );
}

function HeaderObjectiveLine(props: { view: RunBoardSurfaceView }): React.ReactElement {
  return <Text color={visualTokenColor("text.muted")} wrap="truncate">{props.view.objective}</Text>;
}

function shouldShowFocusLine(view: RunBoardSurfaceView): boolean {
  const focus = view.focus?.trim().toLowerCase();
  if (!focus) {
    return false;
  }
  return !view.workers.some((worker) => worker.label.trim().toLowerCase() === focus);
}
