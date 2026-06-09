import { writeTaskOutput, type TaskOutputRef } from "../storage/task-output-store.js";

export type ToolOutputMaterializationInput = {
  sessionId: string;
  taskId: string;
  detail: string;
  result: {
    status?: string;
    outputRef?: string;
    data?: unknown;
    metadata?: unknown;
  };
  maxInlineBytes: number;
  previewBytes: number;
  attempt?: number;
  persistFailed?: boolean;
  wrapUndefinedData?: boolean;
  truncateOptions?: TruncateMiddleOptions;
};

export type MaterializedToolOutput = {
  content?: string;
  outputRef?: string;
  data?: unknown;
};

export async function materializeToolOutput(input: ToolOutputMaterializationInput): Promise<MaterializedToolOutput> {
  const data = input.result.data ?? input.result.metadata;
  const bytes = Buffer.byteLength(input.detail, "utf8");
  const shouldPersist = bytes > input.maxInlineBytes || (input.persistFailed === true && input.result.status === "failed");
  if (!shouldPersist) {
    return { content: input.detail, outputRef: input.result.outputRef, data };
  }
  const ref = await writeTaskOutput({
    sessionId: input.sessionId,
    taskId: input.taskId,
    attempt: input.attempt ?? 0,
    content: input.detail
  });
  return {
    content: bytes <= input.maxInlineBytes
      ? input.detail
      : truncateMiddle(input.detail, input.previewBytes, ref.bytes, ref.lines, ref.path, input.truncateOptions),
    outputRef: ref.path,
    data: attachOutputRef(data, ref, input.wrapUndefinedData ?? true)
  };
}

export type TruncateMiddleOptions = {
  minHeadBytes?: number;
  minTailBytes?: number;
  trimReplacementCharacters?: boolean;
};

export function truncateMiddle(
  content: string,
  maxBytes: number,
  totalBytes: number,
  totalLines: number,
  path: string,
  options: TruncateMiddleOptions = {}
): string {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) {
    return content;
  }
  const headBytes = Math.max(options.minHeadBytes ?? 0, Math.floor(maxBytes * 0.7));
  const tailBytes = Math.max(options.minTailBytes ?? 0, maxBytes - headBytes);
  const head = normalizePreviewBoundary(
    buffer.subarray(0, headBytes).toString("utf8"),
    "tail",
    options.trimReplacementCharacters === true
  );
  const tail = normalizePreviewBoundary(
    buffer.subarray(Math.max(headBytes, buffer.length - tailBytes)).toString("utf8"),
    "head",
    options.trimReplacementCharacters === true
  );
  const omitted = options.trimReplacementCharacters === true
    ? Math.max(0, totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"))
    : Math.max(0, totalBytes - headBytes - tailBytes);
  return [
    head.trimEnd(),
    "",
    `[... ${omitted} bytes omitted from ${totalLines} lines. Full output: ${path}]`,
    "",
    tail.trimStart()
  ].join("\n");
}

function normalizePreviewBoundary(value: string, side: "head" | "tail", trimReplacementCharacters: boolean): string {
  if (!trimReplacementCharacters) {
    return value;
  }
  return side === "tail" ? value.replace(/\uFFFD$/u, "") : value.replace(/^\uFFFD/u, "");
}

function attachOutputRef(data: unknown, ref: TaskOutputRef, wrapUndefinedData: boolean): unknown {
  if (isRecord(data)) {
    return { ...data, outputRef: ref };
  }
  if (data === undefined && !wrapUndefinedData) {
    return { outputRef: ref };
  }
  return { value: data, outputRef: ref };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
