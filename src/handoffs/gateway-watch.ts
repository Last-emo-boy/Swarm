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
import type { HandoffSessionRecord } from "../storage/handoff-store.js";
import type { WorkerRecord } from "../storage/worker-state-store.js";

const HANDOFF_WATCH_JSONL_VERSION = "swarm.handoffs.watch.v1";
const HANDOFF_STATUS_POLL_MS = 500;

export type HandoffWatchProtocol = GatewayWatchProtocol;

export type HandoffWatchSummary = {
  gatewayUrl: string;
  handoff: HandoffSessionRecord;
  worker?: WorkerRecord;
  protocol: HandoffWatchProtocol;
  events: number;
  attachedWorkerSessionId?: string;
  finalStatus: HandoffSessionRecord["status"];
  interrupted: boolean;
};

export class HandoffWatchError extends Error {
  constructor(
    message: string,
    readonly gatewayUrl: string,
    readonly handoffId: string,
    readonly status?: number,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export function isHandoffWatchError(error: unknown): error is HandoffWatchError {
  return error instanceof HandoffWatchError;
}

export async function watchHandoffViaGateway(input: {
  gatewayUrl?: string;
  handoff: HandoffSessionRecord;
  worker?: WorkerRecord;
  protocol?: string;
  jsonl?: boolean;
  writeLine?: (line: string) => void;
}): Promise<HandoffWatchSummary> {
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
    let handoff = input.handoff;
    let worker = input.worker;
    emitWatchStart(writeLine, jsonl, gatewayUrl, protocol, handoff, worker);

    const latest = { handoff, worker };
    const terminal = { handoff: isTerminalHandoffStatus(handoff.status) ? handoff : undefined as HandoffSessionRecord | undefined };
    let events = 0;
    let childWatchSessionId = worker?.worker_session_id;
    let childWatchPromise: Promise<void> | undefined;

    const startChildWatch = (sessionId: string, announce: boolean): void => {
      if (childWatchPromise || !sessionId) {
        return;
      }
      if (announce) {
        emitWatchAttach(writeLine, jsonl, gatewayUrl, protocol, latest.handoff.handoff_id, latest.worker?.worker_id, sessionId);
      }
      childWatchSessionId = sessionId;
      childWatchPromise = consumeGatewaySessionStream({
        gatewayUrl,
        sessionId,
        protocol,
        signal: abortController.signal,
        shouldStop: () => Boolean(terminal.handoff),
        onMessage: ({ event, data }) => {
          if (!messageTargetsSession(protocol, data, sessionId)) {
            return;
          }
          if (emitWatchEvent(writeLine, jsonl, gatewayUrl, protocol, latest.handoff.handoff_id, sessionId, "worker_session", event, data)) {
            events += 1;
          }
        }
      }).then(() => undefined).catch((error: unknown) => {
        if (isGatewayEventStreamError(error)) {
          throw new HandoffWatchError(error.message, error.gatewayUrl, latest.handoff.handoff_id, error.status, error.body);
        }
        throw error;
      });
    };

    if (worker?.worker_session_id) {
      startChildWatch(worker.worker_session_id, false);
    }

    const pollPromise = pollHandoffStatus(gatewayUrl, handoff.handoff_id, handoff.worker_id, abortController.signal, (nextHandoff, nextWorker) => {
      latest.handoff = nextHandoff;
      latest.worker = nextWorker ?? latest.worker;
      if (isTerminalHandoffStatus(nextHandoff.status)) {
        terminal.handoff = nextHandoff;
      }
      const nextSessionId = nextWorker?.worker_session_id;
      if (nextSessionId && nextSessionId !== childWatchSessionId) {
        startChildWatch(nextSessionId, true);
      }
    });

    await consumeGatewaySessionStream({
      gatewayUrl,
      sessionId: handoff.parent_session_id,
      protocol,
      signal: abortController.signal,
      shouldStop: () => Boolean(terminal.handoff),
      onMessage: ({ event, data }) => {
        if (!isRelevantHandoffMessage(protocol, data, latest.handoff.handoff_id, latest.handoff.worker_id)) {
          return;
        }
        if (emitWatchEvent(writeLine, jsonl, gatewayUrl, protocol, latest.handoff.handoff_id, latest.handoff.parent_session_id, "parent_session", event, data)) {
          events += 1;
        }
      }
    }).catch((error: unknown) => {
      if (isGatewayEventStreamError(error)) {
        throw new HandoffWatchError(error.message, error.gatewayUrl, latest.handoff.handoff_id, error.status, error.body);
      }
      throw error;
    });

    const polledTerminal = await pollPromise.catch((error: unknown) => {
      if (abortController.signal.aborted) {
        return undefined;
      }
      throw error;
    });
    if (childWatchPromise) {
      await childWatchPromise;
    }
    abortController.abort();
    handoff = polledTerminal?.handoff ?? terminal.handoff ?? latest.handoff;
    worker = polledTerminal?.worker ?? latest.worker;
    emitWatchEnd(writeLine, jsonl, gatewayUrl, protocol, handoff, worker, events, interrupted);
    return {
      gatewayUrl,
      handoff,
      worker,
      protocol,
      events,
      attachedWorkerSessionId: worker?.worker_session_id,
      finalStatus: handoff.status,
      interrupted
    };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function pollHandoffStatus(
  gatewayUrl: string,
  handoffId: string,
  workerId: string,
  signal: AbortSignal,
  onUpdate: (handoff: HandoffSessionRecord, worker?: WorkerRecord) => void
): Promise<{ handoff: HandoffSessionRecord; worker?: WorkerRecord } | undefined> {
  let latestHandoff: HandoffSessionRecord | undefined;
  let latestWorker: WorkerRecord | undefined;
  while (!signal.aborted) {
    latestHandoff = await readGatewayHandoffRecord(gatewayUrl, handoffId, signal);
    latestWorker = await readGatewayWorkerRecord(gatewayUrl, handoffId, workerId, signal).catch((error: unknown) => {
      if (signal.aborted) {
        return latestWorker;
      }
      throw error;
    });
    onUpdate(latestHandoff, latestWorker);
    if (isTerminalHandoffStatus(latestHandoff.status)) {
      return { handoff: latestHandoff, worker: latestWorker };
    }
    await delay(HANDOFF_STATUS_POLL_MS);
  }
  return latestHandoff ? { handoff: latestHandoff, worker: latestWorker } : undefined;
}

function emitWatchStart(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: HandoffWatchProtocol,
  handoff: HandoffSessionRecord,
  worker?: WorkerRecord
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: HANDOFF_WATCH_JSONL_VERSION,
      type: "watch_start",
      gateway_url: gatewayUrl,
      protocol,
      handoff_id: handoff.handoff_id,
      worker_id: handoff.worker_id,
      parent_session_id: handoff.parent_session_id,
      worker_session_id: worker?.worker_session_id,
      target_agent_spec_id: handoff.target_agent_spec_id,
      status: handoff.status,
      reason: handoff.reason
    }));
    return;
  }
  writeLine("Watching Swarm handoff");
  writeLine(`gateway=${gatewayUrl}`);
  writeLine(`handoff=${handoff.handoff_id} status=${handoff.status}`);
  writeLine(`worker=${handoff.worker_id}`);
  writeLine(`parent_session=${handoff.parent_session_id}`);
  writeLine(`worker_session=${worker?.worker_session_id ?? "(pending)"}`);
  writeLine(`target=${handoff.target_agent_spec_id}`);
  writeLine(`protocol=${protocol}`);
  writeLine(`reason=${handoff.reason}`);
}

function emitWatchAttach(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: HandoffWatchProtocol,
  handoffId: string,
  workerId: string | undefined,
  workerSessionId: string
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: HANDOFF_WATCH_JSONL_VERSION,
      type: "watch_attach",
      gateway_url: gatewayUrl,
      protocol,
      handoff_id: handoffId,
      worker_id: workerId,
      worker_session_id: workerSessionId,
      stream_role: "worker_session"
    }));
    return;
  }
  writeLine(`attached worker_session=${workerSessionId}`);
}

function emitWatchEvent(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: HandoffWatchProtocol,
  handoffId: string,
  streamSessionId: string,
  streamRole: "parent_session" | "worker_session",
  eventName: string,
  data: unknown
): boolean {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: HANDOFF_WATCH_JSONL_VERSION,
      type: "watch_event",
      gateway_url: gatewayUrl,
      protocol,
      handoff_id: handoffId,
      stream_session_id: streamSessionId,
      stream_role: streamRole,
      sse_event: eventName,
      at: eventTimestamp(data),
      data
    }));
    return true;
  }
  const line = protocol === "runtime"
    ? formatGatewayRuntimeWatchLine(eventName, data)
    : formatGatewayWorkWatchLine(data);
  if (!line) {
    return false;
  }
  writeLine(line);
  return true;
}

function emitWatchEnd(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: HandoffWatchProtocol,
  handoff: HandoffSessionRecord,
  worker: WorkerRecord | undefined,
  events: number,
  interrupted: boolean
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: HANDOFF_WATCH_JSONL_VERSION,
      type: "watch_end",
      gateway_url: gatewayUrl,
      protocol,
      handoff_id: handoff.handoff_id,
      worker_id: handoff.worker_id,
      parent_session_id: handoff.parent_session_id,
      worker_session_id: worker?.worker_session_id,
      status: handoff.status,
      worker_status: worker?.status,
      events,
      interrupted
    }));
    return;
  }
  writeLine(`watch ended: status=${handoff.status} events=${events}${interrupted ? " interrupted=true" : ""}`);
}

function isRelevantHandoffMessage(
  protocol: HandoffWatchProtocol,
  payload: unknown,
  handoffId: string,
  workerId: string
): boolean {
  const record = gatewayPayloadWorkRecord(protocol, payload);
  if (!record) {
    return false;
  }
  return workRecordMatchesHandoff(record, handoffId, workerId);
}

function messageTargetsSession(
  protocol: HandoffWatchProtocol,
  payload: unknown,
  sessionId: string
): boolean {
  const record = gatewayPayloadWorkRecord(protocol, payload);
  return record ? workRecordSessionId(record) === sessionId : false;
}

function workRecordMatchesHandoff(record: WorkProtocolRecord, handoffId: string, workerId: string): boolean {
  switch (record.kind) {
    case "queue":
      return record.worker_id === workerId;
    case "task":
      return record.task_id === handoffId
        || record.handoff_id === handoffId
        || record.worker_id === workerId;
    case "runtime_event":
      return record.task_id === handoffId
        || record.worker_id === workerId;
    default:
      return false;
  }
}

function workRecordSessionId(record: WorkProtocolRecord): string | undefined {
  return "session_id" in record && typeof record.session_id === "string"
    ? record.session_id
    : undefined;
}

function isTerminalHandoffStatus(value: HandoffSessionRecord["status"]): boolean {
  return value === "returned" || value === "taken_back" || value === "failed";
}

function resolveGatewayUrl(value?: string): string {
  const fallback = process.env.SWARM_GATEWAY_URL?.trim() || "http://127.0.0.1:38171";
  const resolved = (value?.trim() || fallback).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(resolved)) {
    throw new Error(`Invalid gateway URL: ${resolved}`);
  }
  return resolved;
}

async function readGatewayHandoffRecord(
  gatewayUrl: string,
  handoffId: string,
  signal: AbortSignal
): Promise<HandoffSessionRecord> {
  const payload = await readGatewayJson(`${gatewayUrl}/v1/handoffs/${encodeURIComponent(handoffId)}`, gatewayUrl, handoffId, signal);
  const record = recordValue(payload);
  const handoff = recordValue(record?.handoff) as HandoffSessionRecord | undefined;
  if (!handoff || typeof handoff.handoff_id !== "string") {
    throw new HandoffWatchError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, gatewayUrl, handoffId, 200, payload);
  }
  return handoff;
}

async function readGatewayWorkerRecord(
  gatewayUrl: string,
  handoffId: string,
  workerId: string,
  signal: AbortSignal
): Promise<WorkerRecord> {
  const payload = await readGatewayJson(`${gatewayUrl}/v1/workers/${encodeURIComponent(workerId)}`, gatewayUrl, handoffId, signal);
  const record = recordValue(payload);
  const worker = recordValue(record?.worker) as WorkerRecord | undefined;
  if (!worker || typeof worker.worker_id !== "string") {
    throw new HandoffWatchError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, gatewayUrl, handoffId, 200, payload);
  }
  return worker;
}

async function readGatewayJson(
  url: string,
  gatewayUrl: string,
  handoffId: string,
  signal: AbortSignal
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new HandoffWatchError(
      `Swarm Gateway is not reachable at ${gatewayUrl}. Start \`swarm serve\` or pass --gateway-url <url>. ${message}`,
      gatewayUrl,
      handoffId
    );
  }
  const payload = await readGatewayBody(response);
  if (!response.ok) {
    throw new HandoffWatchError(
      gatewayErrorMessage(payload, response.status),
      gatewayUrl,
      handoffId,
      response.status,
      payload
    );
  }
  return payload;
}

async function readGatewayBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function gatewayErrorMessage(payload: unknown, status: number): string {
  const record = recordValue(payload);
  const nested = recordValue(record?.error);
  return stringValue(nested?.message)
    ?? stringValue(record?.message)
    ?? `Swarm Gateway request failed with HTTP ${status}.`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
