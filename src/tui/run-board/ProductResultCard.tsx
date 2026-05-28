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
import type { AttentionItemView, ResultPreview, RunBoardResultAction } from "./run-board-types.js";
import type { ResultCard } from "../../runtime/result-card.js";
import type { TuiDensity } from "../conversation-layout.js";
import { RunBoardPanel } from "./RunBoardSurface.js";
import { SemanticTextLine, type SemanticTextSpan } from "../components/SemanticTextLine.js";

export function ProductResultCard(props: {
  card?: ResultCard;
  preview: ResultPreview;
  attentionHistory: AttentionItemView[];
  detailHint?: string;
  density?: TuiDensity;
  onNextAction?: (action: RunBoardResultAction) => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%">
      <RunBoardPanel title={props.card ? "Result" : "Result Preview"}>
        {props.card
          ? <ProductResultBody card={props.card} detailHint={props.detailHint} density={props.density} />
          : <Text color={visualTokenColor("text.muted")}>Not finished. Enter an objective or use /continue.</Text>}
      </RunBoardPanel>
      {props.card ? <WorkerSummary preview={props.preview} density={props.density} /> : null}
      {props.card ? <AttentionHistory items={props.attentionHistory} density={props.density} /> : null}
      {props.card ? <NextActions actions={resultNextActions(props.card.next)} onAction={props.onNextAction} density={props.density} /> : null}
    </Box>
  );
}

function ProductResultBody(props: {
  card: ResultCard;
  detailHint?: string;
  density?: TuiDensity;
}): React.ReactElement {
  const card = props.card;
  const changedLimit = props.density === "compact" ? 2 : 4;
  const checkLimit = props.density === "compact" ? 2 : 4;
  const riskLimit = props.density === "compact" ? 1 : 2;
  return (
    <Box flexDirection="column" width="100%">
      <ResultLine label="Status" spans={[
        { text: statusBadge(card.status), color: card.status === "completed" ? "status.success" : card.status === "failed" ? "status.danger" : "status.warning", bold: true },
        { text: " ", color: "text.muted" },
        { text: card.status, color: "text.primary" }
      ]} />
      <ResultLine label="Session" value={`${compactValue(card.sessionId, 18)}  route: ${routeBadge(card.route)}`} />
      <ResultLine label="Risk" value={formatRiskSummary(card)} tone={card.risks.some((risk) => risk.level === "high") ? "status.danger" : card.risks.length ? "status.warning" : "status.success"} />
      <ResultLine label="Summary" value={card.summary} />
      <ResultList label="Changed" empty="none" values={card.changedFiles.slice(0, changedLimit)} remaining={Math.max(0, card.changedFiles.length - changedLimit)} />
      <ResultList
        label="Verified"
        empty="none"
        values={card.checks.slice(0, checkLimit).map((check) => `${statusBadge(check.status)} ${check.command}`)}
        remaining={Math.max(0, card.checks.length - checkLimit)}
        badgeAware
      />
      {card.review.summary ? <ResultLine label="Review" value={`${statusBadge(card.review.status)} ${card.review.summary}`} badgeAware tone={checkStatusTone(card.review.status)} /> : null}
      {props.detailHint ? <Text color={visualTokenColor("text.muted")} wrap="truncate">{props.detailHint}</Text> : null}
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

function formatRiskSummary(card: ResultCard): string {
  if (!card.risks.length) {
    return "low";
  }
  return card.risks.slice(0, 2).map((risk) => {
    const message = "message" in risk ? risk.message : "";
    return message ? `${risk.level}: ${message}` : risk.level;
  }).join(" | ");
}

function WorkerSummary(props: { preview: ResultPreview; density?: TuiDensity }): React.ReactElement | null {
  if (!props.preview.contributors.length) {
    return null;
  }
  const limit = props.density === "compact" ? 2 : 4;
  const visible = props.preview.contributors.slice(0, limit);
  return (
    <RunBoardPanel title="Worker Summary">
      {visible.map((contributor) => (
        <Text key={contributor.workerId} color={visualTokenColor("text.primary")} wrap="truncate">
          [OK] {contributor.label} {contributor.contribution}
        </Text>
      ))}
      {props.preview.contributors.length > visible.length ? (
        <Text color={visualTokenColor("text.muted")}>+{props.preview.contributors.length - visible.length} more workers</Text>
      ) : null}
    </RunBoardPanel>
  );
}

function AttentionHistory(props: { items: AttentionItemView[]; density?: TuiDensity }): React.ReactElement | null {
  if (!props.items.length) {
    return null;
  }
  const limit = props.density === "compact" ? 1 : 3;
  const visible = props.items.slice(0, limit);
  return (
    <RunBoardPanel title="Attention History">
      {visible.map((item) => (
        <Text key={item.id} color={visualTokenColor(item.resolvedAt ? "text.muted" : "status.warning")} wrap="truncate">
          [WARN] {item.summary}{item.resolution ? `; ${item.resolution}` : ""}
        </Text>
      ))}
      {props.items.length > visible.length ? (
        <Text color={visualTokenColor("text.muted")}>+{props.items.length - visible.length} more attention items</Text>
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

function resultNextActions(commands: string[]): RunBoardResultAction[] {
  return commands.map((command) => ({
    command,
    label: command,
    source: "final"
  }));
}
