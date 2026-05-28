import React from "react";
import { Box, Text } from "../ui.js";
import { sectionLabel, visualTokenColor } from "../theme.js";
import type { AttentionAction, AttentionItemView, RunBoardResultAction, RunBoardSurfaceView, WorkerBoardRow } from "./run-board-types.js";
import { WorkerBoard } from "./WorkerBoard.js";
import { AttentionPanel } from "./AttentionPanel.js";
import { ResultPreview } from "./ResultPreview.js";
import { summarizeRunBoardViewCounts } from "./run-board-surface-summary.js";

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
  return (
    <Box flexDirection="column" width="100%">
      <RunBoardPanel title={view.title}>
        {view.objective ? <HeaderObjectiveLine view={view} /> : <SwarmBoardMetaLine view={view} />}
        <Text color={visualTokenColor("text.muted")} wrap="truncate">Phase      {view.phase}</Text>
        {view.focus ? <Text color={visualTokenColor("text.muted")} wrap="truncate">Focus      {view.focus}</Text> : null}
      </RunBoardPanel>
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
      <RunBoardFooter view={view} />
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
  const meta = headerMetaText(props.view);
  const suffix = meta ? `   ${meta}` : "";
  return <Text color={visualTokenColor("text.muted")} wrap="truncate">Objective  {props.view.objective}{suffix}</Text>;
}

function SwarmBoardMetaLine(props: { view: RunBoardSurfaceView }): React.ReactElement | null {
  const text = headerMetaText(props.view);
  if (!text) {
    return null;
  }
  return <Text color={visualTokenColor("text.muted")} wrap="truncate">{text}</Text>;
}

function headerMetaText(view: RunBoardSurfaceView): string {
  const meta = view.meta;
  const parts = [
    meta?.repo ? `repo: ${meta.repo}` : undefined,
    meta?.mode ? `mode: ${meta.mode}` : undefined,
    meta?.risk ? `risk: ${meta.risk}` : undefined,
    meta?.session ? `session: ${meta.session}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.join("  ");
}

function RunBoardFooter(props: { view: RunBoardSurfaceView }): React.ReactElement {
  const counts = summarizeRunBoardViewCounts(props.view);
  const blockedOrStuck = counts.stuck > 0 ? `[Stuck ${counts.stuck}]` : `[Blocked ${counts.blocked}]`;
  return (
    <Box flexDirection="row" width="100%" marginTop={0}>
      <Text color={visualTokenColor("text.muted")} wrap="truncate">
        {[`[Workers ${counts.workers}]`, blockedOrStuck, `[Files ${counts.files}]`, `[Checks ${counts.passedChecks}/${counts.checks}]`, `[Approvals ${counts.approvals}]`, "[Detail Enter]"].join(" ")}
      </Text>
    </Box>
  );
}
