import React from "react";
import { Box, Text } from "../ui.js";
import {
  checkStatusTone,
  compactValue,
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
import type { RecoveryAdvice } from "../../runtime/recovery.js";

export function ProductResultCard(props: {
  view?: ProductResultCardView;
  card?: ResultCard;
  preview?: ResultPreview;
  attentionHistory?: AttentionItemView[];
  detailHint?: string;
  density?: TuiDensity;
  onNextAction?: (action: RunBoardResultAction) => void;
  decisionTrailExpanded?: boolean;
  onDecisionTrailToggle?: () => void;
  teamReasoningExpanded?: boolean;
  onTeamReasoningToggle?: () => void;
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
          ? <ProductResultBody
              view={view}
              density={props.density}
              decisionTrailExpanded={Boolean(props.decisionTrailExpanded)}
              onDecisionTrailToggle={props.onDecisionTrailToggle}
              teamReasoningExpanded={Boolean(props.teamReasoningExpanded)}
              onTeamReasoningToggle={props.onTeamReasoningToggle}
            />
          : <Text color={visualTokenColor("text.muted")}>{view.summary || "Waiting for your first task."}</Text>}
      </RunBoardPanel>
      {view.finished && props.teamReasoningExpanded ? <WorkerSummary view={view} density={props.density} /> : null}
      {view.finished && props.teamReasoningExpanded ? <AttentionHistory view={view} density={props.density} /> : null}
      {view.finished ? <NextActions actions={view.nextActions} onAction={props.onNextAction} density={props.density} /> : null}
    </Box>
  );
}

function emptyPreview(): ResultPreview {
  return {
    status: "empty",
    summary: "Waiting for your first task.",
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
  decisionTrailExpanded?: boolean;
  onDecisionTrailToggle?: () => void;
  teamReasoningExpanded?: boolean;
  onTeamReasoningToggle?: () => void;
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
      {view.sessionId ? <ResultLine label="Session" value={compactValue(view.sessionId, 18)} /> : null}
      <CheckpointLine view={view} />
      {shouldShowRiskLine(view) ? (
        <ResultLine label="Risk" value={view.riskSummary} tone={view.risk === "high" ? "status.danger" : view.risk === "medium" ? "status.warning" : "status.success"} />
      ) : null}
      <ResultLine label="Summary" value={view.summary} />
      <ResultList label="Changed" empty="none" values={view.changedFiles.slice(0, changedLimit)} remaining={Math.max(0, view.changedFiles.length - changedLimit)} />
      <ResultList
        label="Verified"
        empty="none"
        values={view.checks.slice(0, checkLimit).map((check) => `${statusBadge(check.status)} ${check.command}`)}
        remaining={Math.max(0, view.checks.length - checkLimit)}
        badgeAware
      />
      <ReviewFindingLines view={view} density={props.density} />
      {view.review?.summary ? <ResultLine label="Review" value={`${statusBadge(view.review.status)} ${view.review.summary}`} badgeAware tone={checkStatusTone(view.review.status)} /> : null}
      <RecoveryLines view={view} density={props.density} />
      <DecisionTrailLines
        view={view}
        density={props.density}
        expanded={Boolean(props.decisionTrailExpanded)}
        onToggle={props.onDecisionTrailToggle}
      />
      <TeamReasoningLines
        view={view}
        density={props.density}
        expanded={Boolean(props.teamReasoningExpanded)}
        onToggle={props.onTeamReasoningToggle}
      />
      {view.detailHint ? <Text color={visualTokenColor("text.muted")} wrap="truncate">{view.detailHint}</Text> : null}
    </Box>
  );
}

function shouldShowRiskLine(view: ProductResultCardView): boolean {
  return !(view.risk === "low" && view.riskSummary === "low");
}

function CheckpointLine(props: { view: ProductResultCardView }): React.ReactElement | null {
  const checkpoint = props.view.checkpoint;
  if (!checkpoint) {
    return null;
  }
  return (
    <ResultLine
      label="Undo"
      value={`${compactValue(checkpoint.name, 36)} ${checkpoint.revertAvailable ? "available" : "unavailable"}`}
      tone={checkpoint.revertAvailable ? "status.success" : "status.warning"}
    />
  );
}

function ReviewFindingLines(props: {
  view: ProductResultCardView;
  density?: TuiDensity;
}): React.ReactElement | null {
  const findings = props.view.reviewFindings ?? [];
  if (!findings.length) {
    return null;
  }
  const visible = findings.slice(0, props.density === "compact" ? 1 : 3);
  return (
    <React.Fragment>
      {visible.map((finding, index) => {
        const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""} ` : "";
        const recommendation = finding.recommendation ? ` Fix: ${finding.recommendation}` : "";
        return (
          <ResultLine
            key={`finding:${index}:${finding.severity}:${finding.title}`}
            label={index === 0 ? "Finding" : ""}
            value={`${reviewSeverityLabel(finding.severity)}: ${location}${finding.title}${recommendation}`}
            tone={finding.severity === "high" ? "status.danger" : finding.severity === "medium" ? "status.warning" : "text.primary"}
          />
        );
      })}
      {findings.length > visible.length ? (
        <ResultLine label="" value={`+${findings.length - visible.length} more findings`} tone="text.muted" />
      ) : null}
    </React.Fragment>
  );
}

function reviewSeverityLabel(severity: string): string {
  return severity ? `${severity[0]?.toUpperCase() ?? ""}${severity.slice(1)}` : "Finding";
}

function RecoveryLines(props: {
  view: ProductResultCardView;
  density?: TuiDensity;
}): React.ReactElement | null {
  const recovery = props.view.recovery ?? [];
  if (!recovery.length) {
    return null;
  }
  const visible = recovery.slice(0, props.density === "compact" ? 1 : 2);
  return (
    <React.Fragment>
      {visible.map((advice, index) => (
        <ResultLine
          key={`recovery:${index}:${advice.category}:${advice.summary}`}
          label={index === 0 ? "Recovery" : ""}
          value={formatProductRecovery(advice)}
          tone={recoveryTone(advice)}
        />
      ))}
      {recovery.length > visible.length ? (
        <ResultLine label="" value={`+${recovery.length - visible.length} more steps`} tone="text.muted" />
      ) : null}
    </React.Fragment>
  );
}

function formatProductRecovery(advice: RecoveryAdvice): string {
  return [
    advice.summary,
    `Next: ${advice.nextAction}`,
    advice.commandHint ? `Try: ${advice.commandHint}` : undefined
  ].filter(Boolean).join(" ");
}

function recoveryTone(advice: RecoveryAdvice): SemanticTextSpan["color"] {
  if (advice.severity === "error") {
    return "status.danger";
  }
  if (advice.severity === "warning") {
    return "status.warning";
  }
  return "text.primary";
}

function DecisionTrailLines(props: {
  view: ProductResultCardView;
  density?: TuiDensity;
  expanded: boolean;
  onToggle?: () => void;
}): React.ReactElement | null {
  const trail = props.view.decisionTrail;
  if (!trail) {
    return null;
  }
  const sections = (["split", "assign", "verify", "decide", "risk"] as const)
    .map((section) => ({ section, items: trail[section] ?? [] }))
    .filter((entry) => entry.items.length > 0);
  if (!sections.length) {
    return null;
  }
  const visibleSections = props.expanded ? sections : [];
  const itemLimit = props.density === "compact" ? 2 : 4;
  const value = props.expanded
    ? `showing ${sections.length} decisions`
    : `${sections.length} decisions. Show details`;
  return (
    <React.Fragment>
      <ResultLine label="Why" value={value} onClick={props.onToggle} />
      {visibleSections.map((entry) => (
        <ResultLine
          key={`trail:${entry.section}`}
          label={decisionTrailSectionLabel(entry.section)}
          value={entry.items.slice(0, itemLimit).join(" | ")}
          onClick={props.onToggle}
        />
      ))}
    </React.Fragment>
  );
}

function decisionTrailSectionLabel(section: "split" | "assign" | "verify" | "decide" | "risk"): string {
  if (section === "split") return "Plan";
  if (section === "assign") return "Owner";
  if (section === "verify") return "Check";
  if (section === "decide") return "Decision";
  return "Risk";
}

function TeamReasoningLines(props: {
  view: ProductResultCardView;
  density?: TuiDensity;
  expanded: boolean;
  onToggle?: () => void;
}): React.ReactElement | null {
  const items = teamReasoningItems(props.view);
  if (!items.length) {
    return null;
  }
  const visible = props.expanded
    ? items.slice(0, props.density === "compact" ? 4 : 7)
    : [];
  return (
    <React.Fragment>
      <ResultLine
        label="Details"
        value={`${items.length} items. Show details`}
        tone="text.muted"
        onClick={props.onToggle}
      />
      {visible.map((item, index) => (
        <ResultLine
          key={`reasoning:${index}:${item}`}
          label={index === 0 ? "Detail" : ""}
          value={item}
          tone="text.primary"
          onClick={props.onToggle}
        />
      ))}
      {props.expanded && items.length > visible.length ? (
        <ResultLine label="" value={`+${items.length - visible.length} more details`} tone="text.muted" onClick={props.onToggle} />
      ) : null}
    </React.Fragment>
  );
}

function teamReasoningItems(view: ProductResultCardView): string[] {
  const items = [
    ...view.reviewFindings?.flatMap((finding) =>
      (finding.evidence ?? []).slice(0, 2).map((evidence) => `${finding.severity} finding evidence: ${evidence}`)
    ) ?? [],
    ...view.checks.slice(0, 4).map((check) => `verification ${check.status}: ${check.command}`),
    ...view.workerSummary.slice(0, 4).map((worker) => `${worker.label}: ${worker.contribution}`),
    ...view.attentionHistory.slice(0, 3).map((item) => `${item.resolved ? "resolved" : "open"}: ${item.summary}${item.resolution ? `; ${item.resolution}` : ""}`),
    ...view.artifacts.slice(0, 3).map((artifact) => `artifact: ${artifact}`)
  ];
  return Array.from(new Set(items.filter((item) => item.trim())));
}

function ResultLine(props: {
  label: string;
  value?: string;
  spans?: SemanticTextSpan[];
  tone?: SemanticTextSpan["color"];
  badgeAware?: boolean;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <SemanticTextLine
      wrap="truncate"
      onClick={props.onClick}
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
    <RunBoardPanel title="Contributors">
      {visible.map((contributor) => (
        <Text key={contributor.workerId} color={visualTokenColor("text.primary")} wrap="truncate">
          [OK] {contributor.label} {contributor.contribution}
        </Text>
      ))}
      {props.view.workerSummary.length > visible.length ? (
        <Text color={visualTokenColor("text.muted")}>+{props.view.workerSummary.length - visible.length} more contributions</Text>
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
    <RunBoardPanel title="Requests">
      {visible.map((item) => (
        <Text key={item.id} color={visualTokenColor(item.resolved ? "text.muted" : "status.warning")} wrap="truncate">
          [WARN] {item.summary}{item.resolution ? `; ${item.resolution}` : ""}
        </Text>
      ))}
      {props.view.attentionHistory.length > visible.length ? (
        <Text color={visualTokenColor("text.muted")}>+{props.view.attentionHistory.length - visible.length} more requests</Text>
      ) : null}
    </RunBoardPanel>
  );
}

function NextActions(props: {
  actions: RunBoardResultAction[];
  density?: TuiDensity;
  onAction?: (action: RunBoardResultAction) => void;
}): React.ReactElement | null {
  const actions = props.actions;
  if (!actions.length) {
    return null;
  }
  const visible = actions.slice(0, props.density === "compact" ? 2 : 4);
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
