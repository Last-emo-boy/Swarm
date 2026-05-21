import React from "react";
import { Box, Text } from "ink";
import type { ResultCard as ResultCardData } from "../../runtime/result-card.js";
import { formatPromptCacheInline } from "../../runtime/prompt-cache-status.js";
import {
  cacheOutcomeTone,
  checkStatusTone,
  compactValue,
  resultSectionToken,
  routeBadge,
  sectionLabel,
  statusBadge,
  statusTone,
  toneColor,
  type ResultSectionKind,
  type TuiTone
} from "../theme.js";

export function ResultCard(props: { card?: ResultCardData; emptyLabel?: string; detailHint?: string }): React.ReactElement {
  if (!props.card) {
    return (
      <Box flexDirection="column" width="100%">
        <Text color="cyan" bold>{sectionLabel("Result")}</Text>
        <Text color="gray">{props.emptyLabel ?? "not finished"}</Text>
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
  return (
    <Box flexDirection="column" width="100%">
      <Text color="cyan" bold wrap="truncate">{sectionLabel("Result")}</Text>
      <Text wrap="truncate">
        <Text color="gray">{compactValue(card.sessionId, 18)}</Text>
        <Text color="gray"> </Text>
        <Text color={toneColor(statusTone(card.status))}>{statusBadge(card.status)}</Text>
        <Text color="gray"> </Text>
        <Text color="cyan">{routeBadge(card.route)}</Text>
      </Text>
      <SectionLine section="summary" value={card.summary} />
      <SectionLine
        section="changed"
        value={card.changedFiles.length ? card.changedFiles.slice(0, 3).map((file) => compactValue(file, 44)).join(", ") : "none"}
        meta={card.changedFiles.length > 3 ? `+${card.changedFiles.length - 3}` : undefined}
      />
      <SectionLine
        section="checks"
        tone={card.checks.some((check) => check.status === "failed") ? "danger" : card.checks.length ? "success" : "muted"}
        value={visibleChecks.length ? visibleChecks.map((check) => `${compactValue(check.command, 36)} ${statusBadge(check.status)}`).join(", ") : "none"}
        meta={card.checks.length > visibleChecks.length ? `+${card.checks.length - visibleChecks.length}` : undefined}
      />
      <SectionLine
        section="review"
        tone={checkStatusTone(card.review.status)}
        value={`${statusBadge(card.review.status)} ${compactValue(card.review.summary, 96)}`}
      />
      {visibleRisks.length > 0 && (
        <SectionLine
          section="risks"
          tone={visibleRisks.some((risk) => risk.level === "high") ? "danger" : "warning"}
          value={visibleRisks.map((risk) => `${risk.level}: ${compactValue(risk.message, 72)}`).join(" | ")}
          meta={card.risks.length > visibleRisks.length ? `+${card.risks.length - visibleRisks.length}` : undefined}
        />
      )}
      {card.next.length > 0 && (
        <SectionLine section="next" value={card.next.slice(0, 2).join(" · ")} />
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
        <Text color="gray" wrap="truncate">
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
  return (
    <Text wrap="wrap">
      <Text color={toneColor(tone)}>{token.label}</Text>
      <Text color="gray"> </Text>
      <Text color={toneColor(tone)}>{props.value}</Text>
      {props.meta ? <Text color="gray"> {props.meta}</Text> : null}
    </Text>
  );
}
