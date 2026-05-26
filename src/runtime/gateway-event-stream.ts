import { formatRuntimeEventBrief } from "./event-formatters.js";
import type { RuntimeEvent } from "./events.js";
import type { WorkProtocolRecord, WorkTaskRecord } from "./work-protocol.js";

const STREAM_POLL_MS = 500;
const STREAM_IDLE_GRACE_MS = 400;
export const SWARM_GATEWAY_STREAM_SCHEMA_VERSION = "swarm.gateway.stream.v1";

export type GatewayWatchProtocol = "runtime" | "work";

export type GatewayStreamMessage = {
  id?: string;
  event: string;
  data: unknown;
  sequence?: number;
  lastEventId?: number;
  replayWindow?: number;
  missedEventsHint?: GatewayStreamReplayHint;
};

export type GatewaySessionStreamSummary = {
  events: number;
  sawTerminal: boolean;
  lastEventId?: string;
  replayWindow?: number;
  missedEventsHint?: GatewayStreamReplayHint;
};

export type GatewayStreamReplayHint = {
  requested_last_event_id?: number;
  oldest_replayable_event_id?: number;
  replay_window: number;
  missed: boolean;
};

export class GatewayEventStreamError extends Error {
  constructor(
    message: string,
    readonly gatewayUrl: string,
    readonly sessionId?: string,
    readonly status?: number,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export function isGatewayEventStreamError(error: unknown): error is GatewayEventStreamError {
  return error instanceof GatewayEventStreamError;
}

export function parseGatewayWatchProtocol(value?: string): GatewayWatchProtocol {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "work") {
    return "work";
  }
  if (normalized === "runtime") {
    return "runtime";
  }
  throw new Error(`Invalid --protocol: ${value}. Expected runtime or work.`);
}

export async function consumeGatewaySessionStream(input: {
  gatewayUrl: string;
  sessionId?: string;
  protocol: GatewayWatchProtocol;
  lastEventId?: string | number;
  signal: AbortSignal;
  shouldStop?: () => boolean;
  onMessage: (message: GatewayStreamMessage) => void;
}): Promise<GatewaySessionStreamSummary> {
  const path = input.protocol === "work" ? "work-events" : "events";
  const url = input.sessionId
    ? `${input.gatewayUrl}/v1/sessions/${encodeURIComponent(input.sessionId)}/${path}`
    : `${input.gatewayUrl}/v1/${path}`;
  const response = await openGatewayStream(url, input.gatewayUrl, input.sessionId, input.signal, input.lastEventId);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new GatewayEventStreamError("Swarm Gateway event stream is missing a readable body.", input.gatewayUrl, input.sessionId, response.status);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let pendingRead = reader.read();
  let events = 0;
  let sawTerminal = false;
  let lastEventAt = Date.now();
  let lastEventId: string | undefined;
  let replayWindow: number | undefined;
  let missedEventsHint: GatewayStreamReplayHint | undefined;

  while (true) {
    const outcome = await Promise.race([
      pendingRead.then((value) => ({ kind: "read" as const, value })).catch((error: unknown) => ({ kind: "error" as const, error })),
      delay(sawTerminal ? STREAM_IDLE_GRACE_MS : STREAM_POLL_MS).then(() => ({ kind: "tick" as const }))
    ]);

    if (outcome.kind === "tick") {
      if (input.signal.aborted) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (input.shouldStop?.()) {
        sawTerminal = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (sawTerminal && Date.now() - lastEventAt >= STREAM_IDLE_GRACE_MS) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      continue;
    }

    if (outcome.kind === "error") {
      if (input.signal.aborted) {
        break;
      }
      throw outcome.error;
    }

    if (outcome.value.done) {
      break;
    }

    pendingRead = reader.read();
    buffer += decoder.decode(outcome.value.value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const message = parseSseMessage(block);
      if (!message || message.event === "ready") {
        if (message?.event === "ready") {
          const readyMeta = streamEnvelopeMeta(message.data);
          if (readyMeta.replayWindow !== undefined) {
            replayWindow = readyMeta.replayWindow;
          }
          if (readyMeta.missedEventsHint) {
            missedEventsHint = readyMeta.missedEventsHint;
          }
          if (readyMeta.lastEventId !== undefined) {
            lastEventId = String(readyMeta.lastEventId);
          }
        }
        continue;
      }
      const meta = streamEnvelopeMeta(message.data);
      if (meta.sequence !== undefined) {
        message.sequence = meta.sequence;
        lastEventId = String(meta.sequence);
      } else if (message.id) {
        lastEventId = message.id;
      }
      if (meta.lastEventId !== undefined) {
        message.lastEventId = meta.lastEventId;
      }
      if (meta.replayWindow !== undefined) {
        message.replayWindow = meta.replayWindow;
        replayWindow = meta.replayWindow;
      }
      if (meta.missedEventsHint) {
        message.missedEventsHint = meta.missedEventsHint;
        missedEventsHint = meta.missedEventsHint;
      }
      events += 1;
      lastEventAt = Date.now();
      if (gatewayTerminalStatus(input.protocol, message.data)) {
        sawTerminal = true;
      }
      input.onMessage(message);
    }
  }

  return { events, sawTerminal, lastEventId, replayWindow, missedEventsHint };
}

export function formatGatewayRuntimeWatchLine(eventName: string, payload: unknown): string | undefined {
  const record = recordValue(payload);
  const event = runtimeEventValue(record?.event);
  if (!event) {
    return record?.at && typeof record.at === "string"
      ? `${record.at} event: ${eventName}`
      : `event: ${eventName}`;
  }
  const at = stringValue(record?.at) ?? "(unknown)";
  return `${at} ${formatRuntimeEventBrief(event)}`;
}

export function formatGatewayWorkWatchLine(payload: unknown): string | undefined {
  const record = workRecordValue(payload);
  if (!record) {
    return undefined;
  }
  return `${record.at} ${formatWorkRecordBrief(record)}`;
}

export function gatewayTerminalStatus(protocol: GatewayWatchProtocol, payload: unknown): string | undefined {
  if (protocol === "runtime") {
    const event = gatewayPayloadRuntimeEvent(payload);
    if (!event) {
      return undefined;
    }
    if (event.type === "final") {
      return event.status ?? "completed";
    }
    if (event.type === "session" && isTerminalSessionStatus(event.status)) {
      return event.status;
    }
    return undefined;
  }

  const record = workRecordValue(payload);
  if (!record) {
    return undefined;
  }
  if (record.kind === "session" && isTerminalSessionStatus(record.status)) {
    return record.status;
  }
  if (record.kind === "runtime_event" && record.event_type === "final") {
    const event = runtimeEventValue(record.event);
    return event?.type === "final" ? event.status ?? "completed" : "completed";
  }
  return undefined;
}

export function gatewayPayloadRuntimeEvent(payload: unknown): RuntimeEvent | undefined {
  return runtimeEventValue(recordValue(payload)?.event);
}

export function gatewayPayloadWorkRecord(
  protocol: GatewayWatchProtocol,
  payload: unknown
): WorkProtocolRecord | undefined {
  if (protocol === "work") {
    return workRecordValue(payload);
  }
  return workRecordValue(recordValue(payload)?.work);
}

export function eventTimestamp(value: unknown): string | undefined {
  const record = recordValue(value);
  return stringValue(record?.at) ?? stringValue(recordValue(record?.event)?.at);
}

function formatWorkRecordBrief(record: WorkProtocolRecord): string {
  switch (record.kind) {
    case "run":
      return [
        "run:",
        record.phase,
        record.status ? `[${record.status}]` : undefined,
        record.message ? truncate(record.message, 100) : undefined
      ].filter(Boolean).join(" ");
    case "runtime_event":
      return `event: ${record.event_type} ${truncate(record.summary, 100)}`;
    case "activity":
      return [
        `activity:${record.phase}`,
        truncate(record.message, 120),
        record.error_code ? `error=${record.error_code}` : undefined,
        record.recovery_suggestion ? `recovery=${truncate(record.recovery_suggestion, 80)}` : undefined
      ].filter(Boolean).join(" ");
    case "queue":
      return [
        `queue:${record.queue}`,
        record.operation,
        record.worker_id ? `worker=${record.worker_id}` : record.id ? `id=${record.id}` : undefined,
        `size=${record.size}`,
        record.message ? truncate(record.message, 100) : undefined
      ].filter(Boolean).join(" ");
    case "control":
      return `control: ${record.action} - ${truncate(record.reason, 100)}`;
    case "permission":
      return [
        `approval:${record.status}`,
        record.action,
        `${record.risk_class}/${record.risk}`,
        `target=${truncate(record.target, 80)}`,
        record.permission_name ? `permission=${record.permission_name}` : undefined,
        record.permission_rule ? `rule=${record.permission_rule}` : undefined
      ].filter(Boolean).join(" ");
    case "sandbox":
      return [
        `sandbox:${record.status}`,
        `${record.policy}/${record.subject}`,
        record.action ? `action=${record.action}` : undefined,
        record.reason ? `reason=${truncate(record.reason, 100)}` : undefined
      ].filter(Boolean).join(" ");
    case "task":
      return formatTaskRecordBrief(record);
    case "session":
      return `session: ${record.session_id} [${record.status}]`;
  }
}

function formatTaskRecordBrief(record: WorkTaskRecord): string {
  const subject = record.action
    ?? record.capability
    ?? record.agent_spec_id
    ?? record.title
    ?? record.task_id;
  return [
    `task:${record.phase}`,
    truncate(subject, 90),
    record.result_status ? `[${record.result_status}]` : record.status ? `status=${truncate(record.status, 40)}` : undefined,
    record.summary ? truncate(record.summary, 110) : undefined,
    record.write_policy ? `policy=${record.write_policy}` : undefined,
    record.file_scope?.length ? `scope=${truncate(record.file_scope.join(","), 80)}` : undefined,
    record.sandbox ? `sandbox=${record.sandbox.policy}/${record.sandbox.status}` : undefined,
    record.recovery_suggestion ? `recovery=${truncate(record.recovery_suggestion, 80)}` : undefined
  ].filter(Boolean).join(" ");
}

async function openGatewayStream(
  url: string,
  gatewayUrl: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  lastEventId?: string | number
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      headers: lastEventId === undefined ? undefined : { "Last-Event-ID": String(lastEventId) }
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayEventStreamError(
      `Swarm Gateway event stream is not reachable at ${gatewayUrl}. Start \`swarm serve\` or pass --gateway-url <url>. ${message}`,
      gatewayUrl,
      sessionId
    );
  }
  if (!response.ok) {
    const payload = await readGatewayBody(response);
    throw new GatewayEventStreamError(gatewayErrorMessage(payload, response.status), gatewayUrl, sessionId, response.status, payload);
  }
  return response;
}

function parseSseMessage(block: string): GatewayStreamMessage | undefined {
  const lines = block.split(/\r?\n/).map((line) => line.trimEnd());
  const event = lines.find((line) => line.startsWith("event: "))?.slice(7).trim() || "message";
  const id = lines.find((line) => line.startsWith("id: "))?.slice(4).trim();
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n");
  if (!data) {
    return undefined;
  }
  return {
    id: id || undefined,
    event,
    data: parseJsonValue(data)
  };
}

function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readGatewayBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  return parseJsonValue(text);
}

function gatewayErrorMessage(payload: unknown, status: number): string {
  const record = recordValue(payload);
  const nested = recordValue(record?.error);
  return stringValue(nested?.message)
    ?? stringValue(record?.message)
    ?? `Swarm Gateway request failed with HTTP ${status}.`;
}

function streamEnvelopeMeta(value: unknown): {
  sequence?: number;
  lastEventId?: number;
  replayWindow?: number;
  missedEventsHint?: GatewayStreamReplayHint;
} {
  const record = recordValue(value);
  const hint = recordValue(record?.missed_events_hint);
  return {
    sequence: numberValue(record?.sequence),
    lastEventId: numberValue(record?.last_event_id),
    replayWindow: numberValue(record?.replay_window),
    missedEventsHint: hint
      ? {
          requested_last_event_id: numberValue(hint.requested_last_event_id),
          oldest_replayable_event_id: numberValue(hint.oldest_replayable_event_id),
          replay_window: numberValue(hint.replay_window) ?? 0,
          missed: hint.missed === true
        }
      : undefined
  };
}

function runtimeEventValue(value: unknown): RuntimeEvent | undefined {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
    ? value as RuntimeEvent
    : undefined;
}

function workRecordValue(value: unknown): WorkProtocolRecord | undefined {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string"
    ? value as WorkProtocolRecord
    : undefined;
}

function isTerminalSessionStatus(value: string): boolean {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "stopped";
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

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function truncate(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, Math.max(0, limit - 3))}...`
    : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
