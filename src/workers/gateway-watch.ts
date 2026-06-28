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
import type { WorkerRecord } from "../storage/worker-state-store.js";
import { delay, gatewayErrorMessage, recordValue, resolveGatewayUrl, stringValue } from "../server/gateway-client-utils.js";

const WORKER_WATCH_JSONL_VERSION = "swarm.workers.watch.v1";
const WORKER_STATUS_POLL_MS = 500;

export type WorkerWatchProtocol = GatewayWatchProtocol;

export type WorkerWatchSummary = {
  gatewayUrl: string;
  worker: WorkerRecord;
  protocol: WorkerWatchProtocol;
  events: number;
  attachedWorkerSessionId?: string;
  finalStatus: WorkerRecord["status"];
  interrupted: boolean;
};

export class WorkerWatchError extends Error {
  constructor(
    message: string,
    readonly gatewayUrl: string,
    readonly workerId: string,
    readonly status?: number,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export function isWorkerWatchError(error: unknown): error is WorkerWatchError {
  return error instanceof WorkerWatchError;
}

export async function watchWorkerViaGateway(input: {
  gatewayUrl?: string;
  worker: WorkerRecord;
  protocol?: string;
  jsonl?: boolean;
  writeLine?: (line: string) => void;
}): Promise<WorkerWatchSummary> {
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
    let worker = input.worker;
    emitWatchStart(writeLine, jsonl, gatewayUrl, protocol, worker);

    const latest = { worker };
    const terminal = { worker: isTerminalWorkerStatus(worker.status) ? worker : undefined as WorkerRecord | undefined };
    let events = 0;
    let childWatchSessionId = worker.worker_session_id;
    let childWatchPromise: Promise<void> | undefined;

    const startChildWatch = (sessionId: string, announce: boolean): void => {
      if (childWatchPromise || !sessionId) {
        return;
      }
      if (announce) {
        emitWatchAttach(writeLine, jsonl, gatewayUrl, protocol, latest.worker.worker_id, sessionId);
      }
      childWatchSessionId = sessionId;
      childWatchPromise = consumeGatewaySessionStream({
        gatewayUrl,
        sessionId,
        protocol,
        signal: abortController.signal,
        shouldStop: () => Boolean(terminal.worker),
        onMessage: ({ event, data }) => {
          if (!messageTargetsSession(protocol, data, sessionId)) {
            return;
          }
          if (emitWatchEvent(writeLine, jsonl, gatewayUrl, protocol, latest.worker.worker_id, sessionId, "worker_session", event, data)) {
            events += 1;
          }
        }
      }).then(() => undefined).catch((error: unknown) => {
        if (isGatewayEventStreamError(error)) {
          throw new WorkerWatchError(error.message, error.gatewayUrl, latest.worker.worker_id, error.status, error.body);
        }
        throw error;
      });
    };

    if (worker.worker_session_id) {
      startChildWatch(worker.worker_session_id, false);
    }

    const pollPromise = pollWorkerStatus(gatewayUrl, worker.worker_id, abortController.signal, (next) => {
      latest.worker = next;
      if (isTerminalWorkerStatus(next.status)) {
        terminal.worker = next;
      }
      if (next.worker_session_id && next.worker_session_id !== childWatchSessionId) {
        startChildWatch(next.worker_session_id, true);
      }
    });

    await consumeGatewaySessionStream({
      gatewayUrl,
      sessionId: worker.parent_session_id,
      protocol,
      signal: abortController.signal,
      shouldStop: () => Boolean(terminal.worker),
      onMessage: ({ event, data }) => {
        if (!isRelevantWorkerMessage(protocol, data, latest.worker.worker_id, latest.worker.handoff_id)) {
          return;
        }
        if (emitWatchEvent(writeLine, jsonl, gatewayUrl, protocol, latest.worker.worker_id, latest.worker.parent_session_id, "parent_session", event, data)) {
          events += 1;
        }
      }
    }).catch((error: unknown) => {
      if (isGatewayEventStreamError(error)) {
        throw new WorkerWatchError(error.message, error.gatewayUrl, latest.worker.worker_id, error.status, error.body);
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
    worker = polledTerminal ?? terminal.worker ?? latest.worker;
    emitWatchEnd(writeLine, jsonl, gatewayUrl, protocol, worker, events, interrupted);
    return {
      gatewayUrl,
      worker,
      protocol,
      events,
      attachedWorkerSessionId: worker.worker_session_id,
      finalStatus: worker.status,
      interrupted
    };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function pollWorkerStatus(
  gatewayUrl: string,
  workerId: string,
  signal: AbortSignal,
  onUpdate: (worker: WorkerRecord) => void
): Promise<WorkerRecord | undefined> {
  let latest: WorkerRecord | undefined;
  while (!signal.aborted) {
    latest = await readGatewayWorkerRecord(gatewayUrl, workerId, signal);
    onUpdate(latest);
    if (isTerminalWorkerStatus(latest.status)) {
      return latest;
    }
    await delay(WORKER_STATUS_POLL_MS);
  }
  return latest;
}

function emitWatchStart(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: WorkerWatchProtocol,
  worker: WorkerRecord
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: WORKER_WATCH_JSONL_VERSION,
      type: "watch_start",
      gateway_url: gatewayUrl,
      protocol,
      worker_id: worker.worker_id,
      parent_session_id: worker.parent_session_id,
      worker_session_id: worker.worker_session_id,
      handoff_id: worker.handoff_id,
      status: worker.status,
      objective: worker.objective
    }));
    return;
  }
  writeLine("Watching Swarm worker");
  writeLine(`gateway=${gatewayUrl}`);
  writeLine(`worker=${worker.worker_id} status=${worker.status}`);
  writeLine(`parent_session=${worker.parent_session_id}`);
  writeLine(`worker_session=${worker.worker_session_id ?? "(pending)"}`);
  writeLine(`handoff=${worker.handoff_id ?? "(none)"}`);
  writeLine(`protocol=${protocol}`);
  writeLine(`objective=${worker.objective}`);
}

function emitWatchAttach(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: WorkerWatchProtocol,
  workerId: string,
  workerSessionId: string
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: WORKER_WATCH_JSONL_VERSION,
      type: "watch_attach",
      gateway_url: gatewayUrl,
      protocol,
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
  protocol: WorkerWatchProtocol,
  workerId: string,
  streamSessionId: string,
  streamRole: "parent_session" | "worker_session",
  eventName: string,
  data: unknown
): boolean {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: WORKER_WATCH_JSONL_VERSION,
      type: "watch_event",
      gateway_url: gatewayUrl,
      protocol,
      worker_id: workerId,
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
  protocol: WorkerWatchProtocol,
  worker: WorkerRecord,
  events: number,
  interrupted: boolean
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: WORKER_WATCH_JSONL_VERSION,
      type: "watch_end",
      gateway_url: gatewayUrl,
      protocol,
      worker_id: worker.worker_id,
      parent_session_id: worker.parent_session_id,
      worker_session_id: worker.worker_session_id,
      handoff_id: worker.handoff_id,
      status: worker.status,
      events,
      interrupted
    }));
    return;
  }
  writeLine(`watch ended: status=${worker.status} events=${events}${interrupted ? " interrupted=true" : ""}`);
}

function isRelevantWorkerMessage(
  protocol: WorkerWatchProtocol,
  payload: unknown,
  workerId: string,
  handoffId?: string
): boolean {
  const record = gatewayPayloadWorkRecord(protocol, payload);
  if (!record) {
    return false;
  }
  return workRecordMatchesWorker(record, workerId, handoffId);
}

function messageTargetsSession(
  protocol: WorkerWatchProtocol,
  payload: unknown,
  sessionId: string
): boolean {
  const record = gatewayPayloadWorkRecord(protocol, payload);
  return record ? workRecordSessionId(record) === sessionId : false;
}

function workRecordMatchesWorker(record: WorkProtocolRecord, workerId: string, handoffId?: string): boolean {
  switch (record.kind) {
    case "queue":
      return record.worker_id === workerId;
    case "task":
      return record.task_id === workerId
        || record.worker_id === workerId
        || (handoffId ? record.handoff_id === handoffId : false);
    case "runtime_event":
      return record.task_id === workerId
        || record.worker_id === workerId
        || (handoffId ? record.task_id === handoffId : false);
    default:
      return false;
  }
}

function workRecordSessionId(record: WorkProtocolRecord): string | undefined {
  return "session_id" in record && typeof record.session_id === "string"
    ? record.session_id
    : undefined;
}

function isTerminalWorkerStatus(value: WorkerRecord["status"]): boolean {
  return value === "completed" || value === "failed" || value === "stopped";
}

async function readGatewayWorkerRecord(
  gatewayUrl: string,
  workerId: string,
  signal: AbortSignal
): Promise<WorkerRecord> {
  const payload = await readGatewayJson(`${gatewayUrl}/v1/workers/${encodeURIComponent(workerId)}`, gatewayUrl, workerId, signal);
  const record = recordValue(payload);
  const worker = recordValue(record?.worker) as WorkerRecord | undefined;
  if (!worker || typeof worker.worker_id !== "string") {
    throw new WorkerWatchError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, gatewayUrl, workerId, 200, payload);
  }
  return worker;
}

async function readGatewayJson(
  url: string,
  gatewayUrl: string,
  workerId: string,
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
    throw new WorkerWatchError(
      `Swarm Gateway is not reachable at ${gatewayUrl}. Start \`swarm serve\` or pass --gateway-url <url>. ${message}`,
      gatewayUrl,
      workerId
    );
  }
  const payload = await readGatewayBody(response);
  if (!response.ok) {
    throw new WorkerWatchError(
      gatewayErrorMessage(payload, response.status),
      gatewayUrl,
      workerId,
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

