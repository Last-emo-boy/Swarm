import React from "react";
import { Box, Text } from "ink";
import type { ResultCard as ResultCardData } from "../../runtime/result-card.js";
import { formatPromptCacheInline } from "../../runtime/prompt-cache-status.js";
import { sectionLabel, statusBadge } from "../theme.js";

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
  return (
    <Box flexDirection="column" width="100%">
      <Text color="cyan" bold wrap="truncate">{sectionLabel("Result")}</Text>
      <Text wrap="truncate">
        <Text color="gray">{card.sessionId}</Text>
        <Text color="gray"> </Text>
        <Text color={statusColor(card.status)}>{statusBadge(card.status)}</Text>
        <Text color="gray"> </Text>
        <Text color="cyan">{card.route}</Text>
      </Text>
      <Text color="gray" wrap="truncate">{card.summary}</Text>
      <Text color="gray" wrap="truncate">
        changed:{card.changedFiles.length ? card.changedFiles.slice(0, 3).join(", ") : "none"}
        {"  "}checks:{card.checks.length ? card.checks.slice(0, 3).map((check) => `${check.command}[${check.status}]`).join(", ") : "none"}
      </Text>
      <Text color="gray" wrap="truncate">
        review:{card.review.status} {card.review.summary}
      </Text>
      {card.next.length > 0 && (
        <Text color="gray" wrap="truncate">
          next: {card.next.slice(0, 2).join(" · ")}
        </Text>
      )}
      {card.checkpoint && (
        <Text color="gray" wrap="truncate">
          checkpoint:{card.checkpoint.name} {card.checkpoint.revertAvailable ? "rollback:/revert last" : "rollback:locked"}
        </Text>
      )}
      {card.cache && (
        <Text color="gray" wrap="truncate">
          {formatPromptCacheInline(card.cache)}
        </Text>
      )}
      {props.detailHint ? (
        <Text color="gray" wrap="truncate">
          {props.detailHint}
        </Text>
      ) : null}
    </Box>
  );
}

function statusColor(status: ResultCardData["status"]): "green" | "yellow" | "red" {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  return "yellow";
}
