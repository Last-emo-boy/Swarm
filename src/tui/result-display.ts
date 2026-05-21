import type { ExecutionResult } from "../runtime/orchestrator.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { buildResultCard, formatResultCardText } from "../runtime/result-card.js";

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
