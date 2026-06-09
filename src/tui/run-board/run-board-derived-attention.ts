import type { AttentionItem, RunBoardState } from "./run-board-types.js";

export function derivedSlowAttentionItems(
  state: RunBoardState,
  input: { now?: string; workerIds?: readonly string[] } = {}
): AttentionItem[] {
  if (state.phase === "done" || state.phase === "failed" || state.phase === "idle") {
    return [];
  }
  const now = input.now ?? state.config.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const threshold = Math.max(1, state.config.slowThresholdMs);
  const workerIdFilter = input.workerIds ? new Set(input.workerIds) : undefined;
  return [...state.workersById.values()].flatMap((worker): AttentionItem[] => {
    if (workerIdFilter && !workerIdFilter.has(worker.id)) {
      return [];
    }
    if (worker.status !== "active") {
      return [];
    }
    const updatedMs = Date.parse(worker.updatedAt);
    const silentMs = Number.isFinite(updatedMs) ? nowMs - updatedMs : 0;
    if (silentMs < threshold) {
      return [];
    }
    const seconds = Math.floor(silentMs / 1000);
    return [{
      id: `derived:slow:${worker.id}`,
      severity: "warning",
      kind: "slow",
      title: `${worker.label} may be slow`,
      subjectWorkerId: worker.id,
      summary: `No new evidence for ${seconds}s while ${worker.currentAction}.`,
      evidenceIds: worker.lastEvidenceId ? [worker.lastEvidenceId] : [],
      recommendation: "Wait briefly if the process is still alive; review output before stopping.",
      actions: [
        { key: "w", label: "wait", enabled: true },
        { key: "d", label: "details", enabled: true }
      ],
      createdAt: worker.updatedAt,
      updatedAt: now
    }];
  });
}
