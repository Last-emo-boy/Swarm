import type { BlackboardEntry } from "../protocol/types.js";
import { isRecord, firstLine } from "./common-utilities.js";

export function blackboardEntryMatches(entry: BlackboardEntry, query: { type?: BlackboardEntry["type"]; tag?: string; keyPrefix?: string; taskId?: string; agentId?: string }): boolean {
  if (query.type && entry.type !== query.type) return false;
  if (query.taskId && entry.task_id !== query.taskId) return false;
  if (query.keyPrefix && !entry.key.startsWith(query.keyPrefix)) return false;
  if (query.tag && !(entry.tags ?? []).includes(query.tag)) return false;
  if (query.agentId && entry.created_by.agent_id !== query.agentId) return false;
  return true;
}

export function filterBlackboardSearch(entries: BlackboardEntry[], query: string | undefined): BlackboardEntry[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) {
    return entries;
  }
  return entries.filter((entry) => {
    const haystack = [
      entry.key,
      entry.type,
      entry.tags?.join(" "),
      JSON.stringify(entry.value)
    ].filter(Boolean).join("\n").toLowerCase();
    return haystack.includes(needle);
  });
}

export function normalizeLiveControlRequestId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}

export function isLiveControlDirectiveEntry(entry: BlackboardEntry): boolean {
  return entry.key.startsWith("user.live_message.") || (entry.tags ?? []).includes("live-message");
}

export function formatLiveControlDirective(entry: BlackboardEntry): string {
  const value = isRecord(entry.value) ? entry.value : {};
  const decision = isRecord(value.decision) ? value.decision : {};
  const messageId = entry.key.startsWith("user.live_message.")
    ? entry.key.slice("user.live_message.".length)
    : entry.entry_id;
  const createdAt = typeof value.created_at === "string" ? value.created_at : entry.created_at;
  const action = typeof decision.action === "string" ? decision.action : "live_message";
  const reason = typeof decision.reason === "string" ? firstLine(decision.reason) : "";
  const instruction = typeof decision.instruction === "string" ? firstLine(decision.instruction) : "";
  const content = typeof value.content === "string" ? firstLine(value.content) : "";
  return [
    `${createdAt} message_id=${messageId}`,
    `action=${action}`,
    reason ? `reason=${reason}` : undefined,
    instruction ? `instruction=${instruction}` : undefined,
    content ? `content=${content}` : undefined
  ].filter(Boolean).join(" ");
}
