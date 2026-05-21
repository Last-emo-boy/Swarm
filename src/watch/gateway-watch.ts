import {
  consumeGatewaySessionStream,
  eventTimestamp,
  formatGatewayRuntimeWatchLine,
  formatGatewayWorkWatchLine,
  gatewayPayloadWorkRecord,
  isGatewayEventStreamError,
  parseGatewayWatchProtocol,
  type GatewayWatchProtocol
} from "../runtime/gateway-event-stream.js";
import type { WorkProtocolRecord } from "../runtime/work-protocol.js";

const WATCH_JSONL_VERSION = "swarm.watch.v1";

export type WorkspaceWatchProtocol = GatewayWatchProtocol;

export type WorkspaceWatchSummary = {
  gatewayUrl: string;
  protocol: WorkspaceWatchProtocol;
  events: number;
  interrupted: boolean;
};

export class WorkspaceWatchError extends Error {
  constructor(
    message: string,
    readonly gatewayUrl: string,
    readonly status?: number,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export function isWorkspaceWatchError(error: unknown): error is WorkspaceWatchError {
  return error instanceof WorkspaceWatchError;
}

export async function watchWorkspaceViaGateway(input: {
  gatewayUrl?: string;
  protocol?: string;
  jsonl?: boolean;
  writeLine?: (line: string) => void;
}): Promise<WorkspaceWatchSummary> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const protocol = parseGatewayWatchProtocol(input.protocol);
  const jsonl = input.jsonl === true;
  const writeLine = input.writeLine ?? ((line: string) => console.log(line));
  const abortController = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    emitWatchStart(writeLine, jsonl, gatewayUrl, protocol);
    const summary = await consumeGatewaySessionStream({
      gatewayUrl,
      protocol,
      signal: abortController.signal,
      onMessage: ({ event, data }) => {
        emitWatchEvent(writeLine, jsonl, gatewayUrl, protocol, event, data);
      }
    }).catch((error: unknown) => {
      if (isGatewayEventStreamError(error)) {
        throw new WorkspaceWatchError(error.message, error.gatewayUrl, error.status, error.body);
      }
      throw error;
    });
    emitWatchEnd(writeLine, jsonl, gatewayUrl, protocol, summary.events, interrupted);
    return {
      gatewayUrl,
      protocol,
      events: summary.events,
      interrupted
    };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function emitWatchStart(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: WorkspaceWatchProtocol
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: WATCH_JSONL_VERSION,
      type: "watch_start",
      gateway_url: gatewayUrl,
      scope: "workspace",
      protocol
    }));
    return;
  }
  writeLine("Watching Swarm workspace");
  writeLine(`gateway=${gatewayUrl}`);
  writeLine("scope=workspace");
  writeLine(`protocol=${protocol}`);
}

function emitWatchEvent(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: WorkspaceWatchProtocol,
  eventName: string,
  data: unknown
): void {
  const workRecord = gatewayPayloadWorkRecord(protocol, data);
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: WATCH_JSONL_VERSION,
      type: "watch_event",
      gateway_url: gatewayUrl,
      scope: "workspace",
      protocol,
      session_id: workRecordSessionId(workRecord),
      task_id: workRecordTaskId(workRecord),
      sse_event: eventName,
      at: eventTimestamp(data),
      data
    }));
    return;
  }
  const line = protocol === "runtime"
    ? formatGatewayRuntimeWatchLine(eventName, data)
    : formatGatewayWorkWatchLine(data);
  if (!line) {
    return;
  }
  const label = workRecordSessionId(workRecord);
  writeLine(label ? `[${label}] ${line}` : line);
}

function emitWatchEnd(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: WorkspaceWatchProtocol,
  events: number,
  interrupted: boolean
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: WATCH_JSONL_VERSION,
      type: "watch_end",
      gateway_url: gatewayUrl,
      scope: "workspace",
      protocol,
      events,
      interrupted
    }));
    return;
  }
  writeLine(`watch ended: scope=workspace events=${events}${interrupted ? " interrupted=true" : ""}`);
}

function workRecordSessionId(record: WorkProtocolRecord | undefined): string | undefined {
  return record && "session_id" in record && typeof record.session_id === "string"
    ? record.session_id
    : undefined;
}

function workRecordTaskId(record: WorkProtocolRecord | undefined): string | undefined {
  return record && "task_id" in record && typeof record.task_id === "string"
    ? record.task_id
    : undefined;
}

function resolveGatewayUrl(value?: string): string {
  const fallback = process.env.SWARM_GATEWAY_URL?.trim() || "http://127.0.0.1:38171";
  const resolved = (value?.trim() || fallback).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(resolved)) {
    throw new Error(`Invalid gateway URL: ${resolved}`);
  }
  return resolved;
}
