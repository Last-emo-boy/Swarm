import { materializeToolOutput } from "../runtime/tool-result-materializer.js";
import { renderToolResultDetail } from "../tools/local-tools.js";
import type { ToolResult } from "../tools/types.js";

const SLASH_OUTPUT_INLINE_BYTES = 18_000;
const SLASH_OUTPUT_PREVIEW_BYTES = 6_000;

export type PreparedSlashToolOutput = {
  detail: string;
  content?: string;
  outputRef?: string;
};

export async function prepareSlashToolOutput(
  sessionId: string,
  taskId: string,
  result: ToolResult,
  options: { attempt?: number } = {}
): Promise<PreparedSlashToolOutput> {
  const detail = renderToolResultDetail(result);
  const existingRef = result.outputRef;
  const bytes = Buffer.byteLength(detail, "utf8");
  if (existingRef || bytes <= SLASH_OUTPUT_INLINE_BYTES) {
    return {
      detail,
      content: typeof result.content === "string" ? result.content : detail,
      outputRef: existingRef
    };
  }

  const materialized = await materializeToolOutput({
    sessionId,
    taskId,
    attempt: options.attempt ?? Date.now(),
    result,
    detail,
    maxInlineBytes: SLASH_OUTPUT_INLINE_BYTES,
    previewBytes: SLASH_OUTPUT_PREVIEW_BYTES,
    truncateOptions: {
      minHeadBytes: 1_000,
      minTailBytes: 1_000,
      trimReplacementCharacters: true
    }
  });

  return {
    detail,
    content: materialized.content,
    outputRef: materialized.outputRef
  };
}
