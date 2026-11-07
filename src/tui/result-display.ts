import type { ExecutionResult } from "../runtime/orchestrator.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { buildResultCard, formatResultCardText, type ResultCard } from "../runtime/result-card.js";
import type { ConversationMessage } from "./conversation-layout.js";

export type ExecutionResultDisplay = {
  brief: string;
  detail: string;
  preview: string;
};

export function formatExecutionResultDisplay(result: ExecutionResult, runtime?: SwarmRuntime): ExecutionResultDisplay {
  const snapshot = runtime ? safeWorkSnapshot(runtime, result.session_id) : undefined;
  const resultCard = formatResultCardText(result.result_card ?? buildResultCard({ result, route: "work", snapshot }));
  return {
    brief: briefForExecutionResult(result, snapshot),
    detail: [resultCard, "", "Full Output", result.content].join("\n"),
    preview: resultCard
  };
}

/**
 * The line under an answer: how the run ended when it did not complete, and what it changed and checked. Nothing when
 * the run completed without changing or checking anything: the answer says it all.
 */
export function answerFooter(card: ResultCard | undefined): ConversationMessage["footer"] {
  if (!card) {
    return undefined;
  }
  const parts: string[] = [];
  const changed = card.changedFiles.length;
  if (changed) {
    parts.push(`${changed} ${changed === 1 ? "file" : "files"} changed`);
  }
  const failedChecks = card.checks.filter((check) => check.status === "failed").length;
  const passedChecks = card.checks.filter((check) => check.status === "passed").length;
  if (failedChecks) {
    parts.push(`${failedChecks} of ${card.checks.length} checks failed`);
  } else if (passedChecks) {
    parts.push(`${passedChecks} ${passedChecks === 1 ? "check" : "checks"} passed`);
  }
  if (changed && card.checkpoint?.revertAvailable) {
    parts.push("/revert last undoes it");
  }
  // What the review said is in the details; the footer only says that it wants changes.
  if (card.review.status === "failed" || card.review.status === "warning") {
    parts.push(card.review.status === "failed" ? "review failed" : "review asks for changes");
  }
  if (card.status !== "completed") {
    const reason = /Failed tool:\s*(.+)$/u.exec(card.summary)?.[1]?.trim();
    const ended = card.status === "failed" ? "✗ Failed" : "! Stopped";
    return { text: [ended, ...(reason ? [reason] : []), ...parts, "Ctrl+O for details"].join(" · "), status: card.status === "failed" ? "error" : "warning" };
  }
  if (parts.length === 0) {
    return undefined;
  }
  return { text: parts.join(" · "), status: failedChecks || card.review.status === "failed" ? "warning" : "info" };
}

export function briefForExecutionResult(
  result: Pick<ExecutionResult, "content" | "outcome" | "artifact_path" | "status">,
  snapshot?: ReturnType<SwarmRuntime["getWorkSnapshot"]>
): string {
  const brief = briefForOutput(
    result.outcome?.final_summary ?? result.content,
    {
      changed_files: snapshot?.changed_files ?? result.outcome?.changed_files ?? [],
      tests_run: snapshot?.checks ?? result.outcome?.tests_run ?? [],
      intermediate_artifacts: result.outcome?.intermediate_artifacts ?? []
    },
    result.artifact_path
  );
  if (result.status === "failed") {
    return `Failed: ${brief}`;
  }
  if (result.status === "stopped") {
    return `Stopped: ${brief}`;
  }
  return brief;
}

function briefForOutput(
  content: string,
  outcome?: { changed_files: string[]; tests_run: string[]; intermediate_artifacts: string[] },
  artifactPath?: string
): string {
  const lines = content.split(/\r?\n/);
  const first = lines.find((line) => line.trim())?.replace(/^#+\s*/, "").trim() ?? "Swarm output";
  const bytes = Buffer.byteLength(content, "utf8");
  const changed = outcome?.changed_files.length ?? 0;
  const tests = outcome?.tests_run.length ?? 0;
  const artifact = artifactPath ? ` Artifact: ${artifactPath}.` : "";
  return `${first} ... ${lines.length} lines, ${bytes} bytes. Changed files: ${changed}. Checks: ${tests}.${artifact}`;
}

function safeWorkSnapshot(runtime: SwarmRuntime, sessionId: string): ReturnType<SwarmRuntime["getWorkSnapshot"]> | undefined {
  try {
    return runtime.getWorkSnapshot(sessionId);
  } catch {
    return undefined;
  }
}
