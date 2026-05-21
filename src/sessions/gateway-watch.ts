import {
  consumeGatewaySessionStream,
  eventTimestamp,
  formatGatewayRuntimeWatchLine,
  formatGatewayWorkWatchLine,
  gatewayTerminalStatus,
  isGatewayEventStreamError,
  parseGatewayWatchProtocol,
  type GatewayWatchProtocol
} from "../runtime/gateway-event-stream.js";

const SESSION_WATCH_JSONL_VERSION = "swarm.sessions.watch.v1";

export type SessionWatchSummary = {
  gatewayUrl: string;
  sessionId: string;
  protocol: GatewayWatchProtocol;
  events: number;
  finalStatus?: string;
  interrupted: boolean;
};

export class SessionWatchError extends Error {
  constructor(
    message: string,
    readonly gatewayUrl: string,
    readonly sessionId: string,
    readonly status?: number,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export function isSessionWatchError(error: unknown): error is SessionWatchError {
  return error instanceof SessionWatchError;
}

export async function watchSessionViaGateway(input: {
  gatewayUrl?: string;
  sessionId: string;
  protocol?: string;
  jsonl?: boolean;
  writeLine?: (line: string) => void;
}): Promise<SessionWatchSummary> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const protocol = parseGatewayWatchProtocol(input.protocol);
  const jsonl = input.jsonl === true;
  const writeLine = input.writeLine ?? ((line: string) => console.log(line));
  const abortController = new AbortController();
  let interrupted = false;
  let finalStatus: string | undefined;
  const onSignal = () => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    emitWatchStart(writeLine, jsonl, gatewayUrl, protocol, input.sessionId);
    const summary = await consumeGatewaySessionStream({
      gatewayUrl,
      sessionId: input.sessionId,
      protocol,
      signal: abortController.signal,
      onMessage: ({ event, data }) => {
        finalStatus = gatewayTerminalStatus(protocol, data) ?? finalStatus;
        emitWatchEvent(writeLine, jsonl, gatewayUrl, protocol, input.sessionId, event, data);
      }
    }).catch((error: unknown) => {
      if (isGatewayEventStreamError(error)) {
        throw new SessionWatchError(error.message, error.gatewayUrl, error.sessionId ?? input.sessionId, error.status, error.body);
      }
      throw error;
    });
    emitWatchEnd(writeLine, jsonl, gatewayUrl, protocol, input.sessionId, summary.events, finalStatus, interrupted);
    return {
      gatewayUrl,
      sessionId: input.sessionId,
      protocol,
      events: summary.events,
      finalStatus,
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
  protocol: GatewayWatchProtocol,
  sessionId: string
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: SESSION_WATCH_JSONL_VERSION,
      type: "watch_start",
      gateway_url: gatewayUrl,
      protocol,
      session_id: sessionId
    }));
    return;
  }
  writeLine("Watching Swarm session");
  writeLine(`gateway=${gatewayUrl}`);
  writeLine(`session=${sessionId}`);
  writeLine(`protocol=${protocol}`);
}

function emitWatchEvent(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: GatewayWatchProtocol,
  sessionId: string,
  eventName: string,
  data: unknown
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: SESSION_WATCH_JSONL_VERSION,
      type: "watch_event",
      gateway_url: gatewayUrl,
      protocol,
      session_id: sessionId,
      sse_event: eventName,
      at: eventTimestamp(data),
      data
    }));
    return;
  }
  const line = protocol === "runtime"
    ? formatGatewayRuntimeWatchLine(eventName, data)
    : formatGatewayWorkWatchLine(data);
  if (line) {
    writeLine(line);
  }
}

function emitWatchEnd(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: GatewayWatchProtocol,
  sessionId: string,
  events: number,
  finalStatus: string | undefined,
  interrupted: boolean
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: SESSION_WATCH_JSONL_VERSION,
      type: "watch_end",
      gateway_url: gatewayUrl,
      protocol,
      session_id: sessionId,
      status: finalStatus,
      events,
      interrupted
    }));
    return;
  }
  writeLine(`watch ended: status=${finalStatus ?? "open"} events=${events}${interrupted ? " interrupted=true" : ""}`);
}

function resolveGatewayUrl(value?: string): string {
  const fallback = process.env.SWARM_GATEWAY_URL?.trim() || "http://127.0.0.1:38171";
  const resolved = (value?.trim() || fallback).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(resolved)) {
    throw new Error(`Invalid gateway URL: ${resolved}`);
  }
  return resolved;
}
