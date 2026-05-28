import React from "react";
import { Box, Text } from "../ui.js";
import {
  checkStatusTone,
  compactValue,
  routeBadge,
  sectionLabel,
  statusBadge,
  visualTokenColor
} from "../theme.js";
import type { ResultCard } from "../../runtime/result-card.js";
import type { TuiDensity } from "../conversation-layout.js";
import { RunBoardPanel } from "./RunBoardSurface.js";
import { SemanticTextLine, type SemanticTextSpan } from "../components/SemanticTextLine.js";
import {
  productResultCardViewFromParts,
  type ProductResultCardView
} from "./product-result-card-selectors.js";
import type { AttentionItemView, ResultPreview, RunBoardResultAction } from "./run-board-types.js";

export function ProductResultCard(props: {
  view?: ProductResultCardView;
  card?: ResultCard;
  preview?: ResultPreview;
  attentionHistory?: AttentionItemView[];
  detailHint?: string;
  density?: TuiDensity;
  onNextAction?: (action: RunBoardResultAction) => void;
}): React.ReactElement {
  const view = props.view ?? productResultCardViewFromParts({
    card: props.card,
    preview: props.preview ?? emptyPreview(),
    attentionHistory: props.attentionHistory ?? [],
    detailHint: props.detailHint
  });
  return (
    <Box flexDirection="column" width="100%">
      <RunBoardPanel title={view.title}>
        {view.finished
          ? <ProductResultBody view={view} density={props.density} />
          : <Text color={visualTokenColor("text.muted")}>Not finished. Enter an objective or use /continue.</Text>}
      </RunBoardPanel>
      {view.finished ? <WorkerSummary view={view} density={props.density} /> : null}
      {view.finished ? <AttentionHistory view={view} density={props.density} /> : null}
      {view.finished ? <NextActions actions={view.nextActions} onAction={props.onNextAction} density={props.density} /> : null}
    </Box>
  );
}

function emptyPreview(): ResultPreview {
  return {
    status: "empty",
    summary: "Pending. No run evidence yet.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    blockers: [],
    confidence: "low",
    contributors: [],
    risks: [],
    nextActions: []
  };
}

function ProductResultBody(props: {
  view: ProductResultCardView;
  density?: TuiDensity;
}): React.ReactElement {
  const view = props.view;
  const changedLimit = props.density === "compact" ? 2 : 4;
  const checkLimit = props.density === "compact" ? 2 : 4;
  return (
    <Box flexDirection="column" width="100%">
      <ResultLine label="Status" spans={[
        { text: statusBadge(view.status), color: view.status === "success" ? "status.success" : view.status === "failed" ? "status.danger" : "status.warning", bold: true },
        { text: " ", color: "text.muted" },
        { text: view.runtimeStatus ?? view.status, color: "text.primary" }
      ]} />
      {view.sessionId && view.route ? <ResultLine label="Session" value={`${compactValue(view.sessionId, 18)}  route: ${routeBadge(view.route)}`} /> : null}
      <ResultLine label="Risk" value={view.riskSummary} tone={view.risk === "high" ? "status.danger" : view.risk === "medium" ? "status.warning" : "status.success"} />
      <ResultLine label="Summary" value={view.summary} />
      <ResultList label="Changed" empty="none" values={view.changedFiles.slice(0, changedLimit)} remaining={Math.max(0, view.changedFiles.length - changedLimit)} />
      <ResultList
        label="Verified"
        empty="none"
        values={view.checks.slice(0, checkLimit).map((check) => `${statusBadge(check.status)} ${check.command}`)}
        remaining={Math.max(0, view.checks.length - checkLimit)}
        badgeAware
      />
      {view.review?.summary ? <ResultLine label="Review" value={`${statusBadge(view.review.status)} ${view.review.summary}`} badgeAware tone={checkStatusTone(view.review.status)} /> : null}
      {view.detailHint ? <Text color={visualTokenColor("text.muted")} wrap="truncate">{view.detailHint}</Text> : null}
    </Box>
  );
}

function ResultLine(props: {
  label: string;
  value?: string;
  spans?: SemanticTextSpan[];
  tone?: SemanticTextSpan["color"];
  badgeAware?: boolean;
}): React.ReactElement {
  return (
    <SemanticTextLine
      wrap="truncate"
      spans={[
        { text: `${props.label.padEnd(8, " ")} `, color: "text.muted", bold: true },
        ...(props.spans ?? valueSpans(props.value ?? "", props.badgeAware, props.tone))
      ]}
    />
  );
}

function ResultList(props: {
  label: string;
  values: string[];
  empty: string;
  remaining?: number;
  badgeAware?: boolean;
}): React.ReactElement {
  const value = props.values.length ? props.values.join(", ") : props.empty;
  const suffix = props.remaining ? ` +${props.remaining}` : "";
  return <ResultLine label={props.label} value={`${value}${suffix}`} badgeAware={props.badgeAware} />;
}

function valueSpans(value: string, badgeAware = false, tone?: SemanticTextSpan["color"]): SemanticTextSpan[] {
  if (!badgeAware) {
    return [{ text: value, color: tone ?? "text.primary" }];
  }
  return value.split(/(\[(?:OK|ERR|WARN|ASK|RUN|SKIP|--)\])/gu).filter(Boolean).map((part) => ({
    text: part,
    color: badgeColor(part) ?? tone ?? "text.primary",
    bold: Boolean(badgeColor(part))
  }));
}

function badgeColor(value: string): SemanticTextSpan["color"] | undefined {
  switch (value) {
    case "[OK]": return "status.success";
    case "[ERR]": return "status.danger";
    case "[WARN]": return "status.warning";
    case "[ASK]": return "status.pending";
    case "[RUN]": return "status.running";
    case "[SKIP]":
    case "[--]": return "text.muted";
    default: return undefined;
  }
}

function WorkerSummary(props: { view: ProductResultCardView; density?: TuiDensity }): React.ReactElement | null {
  if (!props.view.workerSummary.length) {
    return null;
  }
  const limit = props.density === "compact" ? 2 : 4;
  const visible = props.view.workerSummary.slice(0, limit);
  return (
    <RunBoardPanel title="Worker Summary">
      {visible.map((contributor) => (
        <Text key={contributor.workerId} color={visualTokenColor("text.primary")} wrap="truncate">
          [OK] {contributor.label} {contributor.contribution}
        </Text>
      ))}
      {props.view.workerSummary.length > visible.length ? (
        <Text color={visualTokenColor("text.muted")}>+{props.view.workerSummary.length - visible.length} more workers</Text>
      ) : null}
    </RunBoardPanel>
  );
}

function AttentionHistory(props: { view: ProductResultCardView; density?: TuiDensity }): React.ReactElement | null {
  if (!props.view.attentionHistory.length) {
    return null;
  }
  const limit = props.density === "compact" ? 1 : 3;
  const visible = props.view.attentionHistory.slice(0, limit);
  return (
    <RunBoardPanel title="Attention History">
      {visible.map((item) => (
        <Text key={item.id} color={visualTokenColor(item.resolved ? "text.muted" : "status.warning")} wrap="truncate">
          [WARN] {item.summary}{item.resolution ? `; ${item.resolution}` : ""}
        </Text>
      ))}
      {props.view.attentionHistory.length > visible.length ? (
        <Text color={visualTokenColor("text.muted")}>+{props.view.attentionHistory.length - visible.length} more attention items</Text>
      ) : null}
    </RunBoardPanel>
  );
}

function NextActions(props: {
  actions: RunBoardResultAction[];
  density?: TuiDensity;
  onAction?: (action: RunBoardResultAction) => void;
}): React.ReactElement | null {
  if (!props.actions.length) {
    return null;
  }
  const visible = props.actions.slice(0, props.density === "compact" ? 2 : 4);
  return (
    <Box flexDirection="row" width="100%" marginBottom={1}>
      <Text color={visualTokenColor("text.primary")} bold>{sectionLabel("Next")}</Text>
      {visible.map((action) => (
        <Box
          key={`next:${action.command}`}
          flexDirection="row"
          marginLeft={2}
          focusable={Boolean(props.onAction)}
          onClick={props.onAction ? (() => props.onAction?.(action)) as never : undefined}
        >
          <Text color={visualTokenColor("brand.focus")}>{action.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
