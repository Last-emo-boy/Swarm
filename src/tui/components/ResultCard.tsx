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
  routeBadge,
  sectionLabel,
  statusTone,
  toneColor,
  visualTokenColor,
  type ResultSectionKind,
  type TuiTone
} from "../theme.js";
import type { TuiDensity } from "../conversation-layout.js";
import { SemanticTextLine, semanticToolLineSpans, type SemanticTextSpan } from "./SemanticTextLine.js";
import { StatusIcon, statusIconText } from "./StatusIcon.js";
import { toolResponseLineSpans } from "./ToolResponseSurface.js";

export function ResultCard(props: { card?: ResultCardData; emptyLabel?: string; detailHint?: string; density?: TuiDensity }): React.ReactElement {
  if (!props.card) {
    return (
      <Box flexDirection="column" width="100%">
        <Text color={visualTokenColor("text.primary")} bold>{sectionLabel("Result")}</Text>
        <Text color={visualTokenColor("text.muted")}>{props.emptyLabel ?? "not finished"}</Text>
      </Box>
    );
  }
  const card = props.card;
  const failedChecks = card.checks.filter((check) => check.status === "failed");
  const visibleChecks = [
    ...failedChecks,
    ...card.checks.filter((check) => check.status !== "failed")
  ].slice(0, 3);
  const visibleRisks = [
    ...card.risks.filter((risk) => risk.level === "high"),
    ...card.risks.filter((risk) => risk.level !== "high")
  ].slice(0, 2);
  const visibleRecovery = (card.recovery ?? []).slice(0, 2);
  const density = props.density ?? "default";
  const visibleArtifacts = card.artifacts.slice(0, density === "compact" ? 1 : 2);
  return (
    <Box flexDirection="column" width="100%">
      <Text color={visualTokenColor("text.primary")} bold wrap="truncate">{sectionLabel("Result")}</Text>
      <Text wrap="truncate">
        <Text color={visualTokenColor("text.muted")}>{compactValue(card.sessionId, 18)}</Text>
        <Text color={visualTokenColor("text.muted")}> </Text>
        <StatusIcon status={card.status} label="badge" />
        <Text color={visualTokenColor("text.muted")}> </Text>
        <Text color={visualTokenColor("text.primary")}>{routeBadge(card.route)}</Text>
      </Text>
      <SectionLine section="summary" value={density === "compact" ? compactValue(card.summary, 80) : card.summary} />
      <SectionLine
        section="changed"
        value={card.changedFiles.length ? card.changedFiles.slice(0, density === "compact" ? 2 : 3).map((file) => compactValue(file, 44)).join(", ") : "none"}
        meta={card.changedFiles.length > 3 ? `+${card.changedFiles.length - 3}` : undefined}
      />
      <SectionLine
        section="checks"
        tone={card.checks.some((check) => check.status === "failed") ? "danger" : card.checks.length ? "success" : "muted"}
        value={visibleChecks.length ? visibleChecks.slice(0, density === "compact" ? 2 : visibleChecks.length).map((check) => `${compactValue(check.command, 36)} ${statusIconText(check.status, "badge")}`).join(", ") : "none"}
        meta={card.checks.length > visibleChecks.length ? `+${card.checks.length - visibleChecks.length}` : undefined}
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
          meta={card.risks.length > visibleRisks.length ? `+${card.risks.length - visibleRisks.length}` : undefined}
        />
      )}
      {visibleRecovery.length > 0 && (
        <SectionLine
          section="recovery"
          tone={visibleRecovery.some((advice) => advice.severity === "error") ? "danger" : "warning"}
          value={visibleRecovery.map((advice) => compactValue(formatRecoveryAdviceInline(advice), 112)).join(" | ")}
          meta={(card.recovery?.length ?? 0) > visibleRecovery.length ? `+${(card.recovery?.length ?? 0) - visibleRecovery.length}` : undefined}
        />
      )}
      {visibleArtifacts.length > 0 && (
        <React.Fragment>
          <SectionLine
            section="artifacts"
            value={`${visibleArtifacts.length} saved`}
            meta={card.artifacts.length > visibleArtifacts.length ? `+${card.artifacts.length - visibleArtifacts.length}` : undefined}
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

function SectionLine(props: {
  section: ResultSectionKind;
  value: string;
  meta?: string;
  tone?: TuiTone;
}): React.ReactElement {
  const token = resultSectionToken(props.section);
  const tone = props.tone ?? token.tone;
  const valueSpans = resultValueSpans(props.value);
  return (
    <SemanticTextLine
      wrap="wrap"
      spans={[
        { text: token.label, color: tone, bold: true },
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
