import type { WorkItem } from "../protocol/types.js";

export const SYMPHONY_SESSION_SOURCES = ["symphony", "tracker"] as const;

export function workItemSourceId(item: WorkItem): string {
  return item.source_id ?? item.external_id ?? item.human_id ?? item.title;
}

export function workItemLabel(item: WorkItem | undefined): string {
  if (!item) {
    return "-";
  }
  return item.human_id ?? item.source_id ?? item.external_id ?? item.title;
}

export function workItemSourceKind(item: WorkItem): string {
  return String(item.metadata.work_source_kind ?? "");
}

export function workItemKey(item: WorkItem): string {
  return [item.source, workItemSourceKind(item), workItemSourceId(item)].join(":");
}
