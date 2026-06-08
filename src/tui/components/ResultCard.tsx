import React from "react";
import { Box, Text } from "../ui.js";
import type { ResultCard as ResultCardData } from "../../runtime/result-card.js";
import { formatPromptCacheInline } from "../../runtime/prompt-cache-status.js";
import { formatRecoveryAdviceInline } from "../../runtime/recovery.js";
import {
  cacheOutcomeTone,
  checkStatusTone,
  compactValue,
  resultSectionToken,
  sectionLabel,
  visualTokenColor,
  type ResultSectionKind,
  type TuiTone
} from "../theme.js";
import type { TuiDensity } from "../conversation-layout.js";
import { SemanticTextLine, semanticToolLineSpans, type SemanticTextSpan } from "./SemanticTextLine.js";
import { statusIconText } from "./StatusIcon.js";
import { toolResponseLineSpans } from "./ToolResponseSurface.js";

export function ResultCard(props: {
  card?: ResultCardData;
  emptyLabel?: string;
  detailHint?: string;
  density?: TuiDensity;
  decisionTrailExpanded?: boolean;
  onDecisionTrailToggle?: () => void;
}): React.ReactElement {
  if (!props.card) {
    return (
      <Box flexDirection="column" width="100%">
        <Text color={visualTokenColor("text.primary")} bold>{sectionLabel("Result")}</Text>
        <Text color={visualTokenColor("text.muted")}>{props.emptyLabel ?? "not finished"}</Text>
      </Box>
    );
  }
  const card = props.card;
  const visibleRisks = [
    ...card.risks.filter((risk) => risk.level === "high"),
    ...card.risks.filter((risk) => risk.level !== "high")
  ].slice(0, 2);
  const visibleRecovery = (card.recovery ?? []).slice(0, 2);
  const density = props.density ?? "default";
  const checkSummary = resultCardCheckSummary(card.checks, density === "compact" ? 2 : 3);
  const visibleArtifacts = card.artifacts.slice(0, density === "compact" ? 1 : 2);
  return (
    <Box flexDirection="column" width="100%">
      <Text color={visualTokenColor("text.primary")} bold wrap="truncate">{sectionLabel("Result")}</Text>
      <SectionLine section="summary" value={density === "compact" ? compactValue(card.summary, 80) : card.summary} />
      {card.changedFiles.length > 0 ? (
        <SectionLine
          section="changed"
          value={card.changedFiles.slice(0, density === "compact" ? 2 : 3).map((file) => compactValue(file, 44)).join(", ")}
        />
      ) : null}
      <SectionLine
        section="checks"
        tone={card.checks.some((check) => check.status === "failed") ? "danger" : card.checks.length ? "success" : "muted"}
        value={checkSummary ?? "none"}
      />
      <SectionLine
        section="review"
        tone={checkStatusTone(card.review.status)}
        value={`${statusIconText(card.review.status, "badge")} ${compactValue(card.review.summary, 96)}`}
      />
      {visibleRisks.length > 0 && (
        <SectionLine
          section="risks"
          tone={visibleRisks.some((risk) => risk.level === "high") ? "danger" : "warning"}
          value={visibleRisks.map((risk) => `${risk.level}: ${compactValue(risk.message, 72)}`).join(" | ")}
        />
      )}
      {visibleRecovery.length > 0 && (
        <SectionLine
          section="recovery"
          tone={visibleRecovery.some((advice) => advice.severity === "error") ? "danger" : "warning"}
          value={visibleRecovery.map((advice) => compactValue(formatRecoveryAdviceInline(advice), 112)).join(" | ")}
        />
      )}
      {visibleArtifacts.length > 0 && (
        <React.Fragment>
          <SectionLine
            section="artifacts"
            value="saved"
          />
          {visibleArtifacts.map((artifact, index) => (
            <SemanticTextLine
              key={`artifact:${index}:${artifact}`}
              wrap="wrap"
              spans={[
                { text: "  ", color: "text.muted" },
                ...toolResponseLineSpans(`artifact=${compactValue(artifact, 96)}`, {
                  defaultColor: "text.muted",
                  valueColor: "text.muted",
                  fallbackLabel: "artifact"
                })
              ]}
            />
          ))}
        </React.Fragment>
      )}
      {card.next.length > 0 && (
        <SectionLine section="next" value={card.next.slice(0, density === "compact" ? 1 : 2).join(" · ")} />
      )}
      {card.decisionTrail && (
        <DecisionTrailSection
          card={card}
          density={density}
          expanded={Boolean(props.decisionTrailExpanded)}
          onToggle={props.onDecisionTrailToggle}
        />
      )}
      {card.checkpoint && (
        <SectionLine
          section="checkpoint"
          tone={card.checkpoint.revertAvailable ? "running" : "warning"}
          value={`${compactValue(card.checkpoint.name, 40)} ${card.checkpoint.mode}`}
          meta={card.checkpoint.revertAvailable ? "rollback /revert last" : "rollback locked"}
        />
      )}
      {card.cache && (
        <SectionLine
          section="cache"
          tone={cacheOutcomeTone(card.cache.status)}
          value={formatPromptCacheInline(card.cache) ?? card.cache.status}
        />
      )}
      {props.detailHint ? (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          {props.detailHint}
        </Text>
      ) : null}
    </Box>
  );
}

function DecisionTrailSection(props: {
  card: ResultCardData;
  density: TuiDensity;
  expanded: boolean;
  onToggle?: () => void;
}): React.ReactElement | null {
  const trail = props.card.decisionTrail;
  if (!trail) {
    return null;
  }
  const sections = (["split", "assign", "verify", "decide", "risk"] as const)
    .map((section) => ({ section, items: trail[section] ?? [] }))
    .filter((entry) => entry.items.length > 0);
  if (!sections.length) {
    return null;
  }
  const visible = props.expanded ? sections : [];
  const itemLimit = props.density === "compact" ? 2 : 4;
  return (
    <React.Fragment>
      <SectionLine
        section="trail"
        label="WHY"
        value="Decisions"
        onClick={props.onToggle}
      />
      {visible.map((entry) => (
        <SectionLine
          key={`trail:${entry.section}`}
          section="trail"
          label={decisionTrailSectionLabel(entry.section)}
          value={entry.items.slice(0, itemLimit).join(" | ")}
          onClick={props.onToggle}
        />
      ))}
    </React.Fragment>
  );
}

function decisionTrailSectionLabel(section: "split" | "assign" | "verify" | "decide" | "risk"): string {
  if (section === "split") return "PLAN";
  if (section === "assign") return "OWNER";
  if (section === "verify") return "CHECK";
  if (section === "decide") return "DECISION";
  return "RISK";
}

function resultCardCheckSummary(checks: ResultCardData["checks"], limit: number): string | undefined {
  if (!checks.length) {
    return undefined;
  }
  const failed = checks.filter((check) => check.status === "failed");
  if (failed.length) {
    return failed.slice(0, limit).map((check) => `${compactValue(check.command, 36)} ${statusIconText(check.status, "badge")}`).join(", ");
  }
  const skipped = checks.filter((check) => check.status === "skipped");
  if (skipped.length === checks.length) {
    return "Skipped";
  }
  const passed = checks.some((check) => check.status === "passed");
  if (passed) {
    return skipped.length ? "Passed; some skipped" : "Passed";
  }
  return "Pending";
}

function SectionLine(props: {
  section: ResultSectionKind;
  value: string;
  label?: string;
  meta?: string;
  tone?: TuiTone;
  onClick?: () => void;
}): React.ReactElement {
  const token = resultSectionToken(props.section);
  const tone = props.tone ?? token.tone;
  const valueSpans = resultValueSpans(props.value);
  return (
    <SemanticTextLine
      wrap="wrap"
      onClick={props.onClick}
      spans={[
        { text: props.label ?? token.label, color: tone, bold: true },
        { text: " ", color: "text.muted" },
        ...valueSpans,
        ...(props.meta ? [{ text: ` ${props.meta}`, color: "text.muted" } satisfies SemanticTextSpan] : [])
      ]}
    />
  );
}

function resultValueSpans(value: string): SemanticTextSpan[] {
  const parts = value.split(/(\[(?:OK|ERR|WARN|ASK|RUN|--)\])/gu);
  return parts.flatMap((part) => {
    if (!part) {
      return [];
    }
    const badgeColor = badgeTone(part);
    if (badgeColor) {
      return [{ text: part, color: badgeColor, bold: true }];
    }
    return semanticToolLineSpans(part, { defaultColor: "text.primary" });
  });
}

function badgeTone(value: string): SemanticTextSpan["color"] | undefined {
  switch (value) {
    case "[OK]": return "status.success";
    case "[ERR]": return "status.danger";
    case "[WARN]": return "status.warning";
    case "[ASK]": return "status.pending";
    case "[RUN]": return "status.running";
    case "[--]": return "text.muted";
    default: return undefined;
  }
}
