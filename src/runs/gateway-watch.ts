import {
  consumeGatewaySessionStream,
  eventTimestamp,
  formatGatewayRuntimeWatchLine,
  formatGatewayWorkWatchLine,
  isGatewayEventStreamError,
  parseGatewayWatchProtocol,
  type GatewayWatchProtocol
} from "../runtime/gateway-event-stream.js";
import {
  readGatewayRunRecord,
  resolveGatewayRunRecord,
  resolveGatewayUrl,
  type GatewayRunRecord
} from "./gateway-report.js";

const RUN_WATCH_JSONL_VERSION = "swarm.runs.watch.v1";
const RUN_STATUS_POLL_MS = 500;

export type RunWatchProtocol = GatewayWatchProtocol;

export type RunWatchSummary = {
  gatewayUrl: string;
  run: GatewayRunRecord;
  protocol: RunWatchProtocol;
  events: number;
  attachedSessionId?: string;
  finalStatus?: string;
  interrupted: boolean;
};

export class RunWatchError extends Error {
  constructor(
    message: string,
    readonly gatewayUrl: string,
    readonly runId?: string,
    readonly status?: number,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export function isRunWatchError(error: unknown): error is RunWatchError {
  return error instanceof RunWatchError;
}

export async function watchRunViaGateway(input: {
  gatewayUrl?: string;
  selector?: string;
  protocol?: string;
  jsonl?: boolean;
  writeLine?: (line: string) => void;
  pollIntervalMs?: number;
}): Promise<RunWatchSummary> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const protocol = parseGatewayWatchProtocol(input.protocol);
  const jsonl = input.jsonl === true;
  const writeLine = input.writeLine ?? ((line: string) => console.log(line));
  const abortController = new AbortController();
  let interrupted = false;
  let pollPromise: Promise<GatewayRunRecord | undefined> | undefined;
  const onSignal = () => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    let run = await resolveGatewayRunRecord(gatewayUrl, input.selector);
    emitWatchStart(writeLine, jsonl, gatewayUrl, protocol, run);

    const initialSessionId = run.session_id;
    run = await waitForRunSession(run, gatewayUrl, abortController.signal, writeLine, jsonl, protocol, pollIntervalMs(input.pollIntervalMs));
    const attachedSessionId = run.session_id;
    if (attachedSessionId && attachedSessionId !== initialSessionId) {
      emitWatchAttach(writeLine, jsonl, gatewayUrl, protocol, run.run_id, attachedSessionId);
    }

    if (!run.session_id) {
      emitNoSessionAvailable(writeLine, jsonl, gatewayUrl, protocol, run);
      emitWatchEnd(writeLine, jsonl, gatewayUrl, protocol, run, 0, interrupted);
      return {
        gatewayUrl,
        run,
        protocol,
        events: 0,
        attachedSessionId: run.session_id,
        finalStatus: run.status,
        interrupted
      };
    }

    const latest = { run };
    const terminal = { run: isTerminalRunStatus(run.status) ? run : undefined as GatewayRunRecord | undefined };
    pollPromise = pollRunStatus(gatewayUrl, run.run_id, abortController.signal, pollIntervalMs(input.pollIntervalMs), (next) => {
      latest.run = next;
      if (isTerminalRunStatus(next.status)) {
        terminal.run = next;
      }
    });

    const streamSummary = await consumeGatewaySessionStream({
      gatewayUrl,
      sessionId: run.session_id,
      protocol,
      signal: abortController.signal,
      shouldStop: () => Boolean(terminal.run),
      onMessage: ({ event, data }) => {
        emitWatchEvent(writeLine, jsonl, gatewayUrl, protocol, latest.run, event, data);
      }
    }).catch((error: unknown) => {
      if (isGatewayEventStreamError(error)) {
        throw new RunWatchError(error.message, error.gatewayUrl, run.run_id, error.status, error.body);
      }
      throw error;
    });

    abortController.abort();
    const polledTerminal = await pollPromise.catch(() => undefined);
    const finalRun = polledTerminal ?? terminal.run ?? latest.run;
    emitWatchEnd(writeLine, jsonl, gatewayUrl, protocol, finalRun, streamSummary.events, interrupted);
    return {
      gatewayUrl,
      run: finalRun,
      protocol,
      events: streamSummary.events,
      attachedSessionId: finalRun.session_id,
      finalStatus: finalRun.status,
      interrupted
    };
  } finally {
    abortController.abort();
    await pollPromise?.catch(() => undefined);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function waitForRunSession(
  initialRun: GatewayRunRecord,
  gatewayUrl: string,
  signal: AbortSignal,
  writeLine: (line: string) => void,
  jsonl: boolean,
  protocol: RunWatchProtocol,
  pollMs: number
): Promise<GatewayRunRecord> {
  let run = initialRun;
  let announced = false;
  while (!run.session_id && !isTerminalRunStatus(run.status)) {
    if (signal.aborted) {
      return run;
    }
    if (!announced) {
      announced = true;
      if (jsonl) {
        writeLine(JSON.stringify({
          schema_version: RUN_WATCH_JSONL_VERSION,
          type: "watch_waiting",
          gateway_url: gatewayUrl,
          protocol,
          run_id: run.run_id,
          status: run.status,
          reason: "waiting_for_session"
        }));
      } else {
        writeLine("waiting for session attachment...");
      }
    }
    await delay(pollMs);
    run = await readGatewayRunRecord(gatewayUrl, run.run_id);
  }
  return run;
}

async function pollRunStatus(
  gatewayUrl: string,
  runId: string,
  signal: AbortSignal,
  pollMs: number,
  onUpdate: (run: GatewayRunRecord) => void
): Promise<GatewayRunRecord | undefined> {
  let latest: GatewayRunRecord | undefined;
  while (!signal.aborted) {
    latest = await readGatewayRunRecord(gatewayUrl, runId);
    onUpdate(latest);
    if (isTerminalRunStatus(latest.status)) {
      return latest;
    }
    await delay(pollMs);
  }
  return latest;
}

function emitWatchStart(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: RunWatchProtocol,
  run: GatewayRunRecord
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: RUN_WATCH_JSONL_VERSION,
      type: "watch_start",
      gateway_url: gatewayUrl,
      protocol,
      run
    }));
    return;
  }
  writeLine("Watching Swarm run");
  writeLine(`gateway=${gatewayUrl}`);
  writeLine(`run=${run.run_id} status=${run.status} mode=${run.mode}`);
  writeLine(`session=${run.session_id ?? "(pending)"}`);
  writeLine(`protocol=${protocol}`);
  writeLine(`objective=${run.objective}`);
}

function emitWatchAttach(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: RunWatchProtocol,
  runId: string,
  sessionId: string
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: RUN_WATCH_JSONL_VERSION,
      type: "watch_attach",
      gateway_url: gatewayUrl,
      protocol,
      run_id: runId,
      session_id: sessionId
    }));
    return;
  }
  writeLine(`attached session=${sessionId}`);
}

function emitNoSessionAvailable(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: RunWatchProtocol,
  run: GatewayRunRecord
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: RUN_WATCH_JSONL_VERSION,
      type: "watch_unavailable",
      gateway_url: gatewayUrl,
      protocol,
      run_id: run.run_id,
      status: run.status,
      reason: "session_unavailable"
    }));
    return;
  }
  writeLine("no session event stream is available for this run.");
}

function emitWatchEvent(
  writeLine: (line: string) => void,
  jsonl: boolean,
  gatewayUrl: string,
  protocol: RunWatchProtocol,
  run: GatewayRunRecord,
  eventName: string,
  data: unknown
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: RUN_WATCH_JSONL_VERSION,
      type: "watch_event",
      gateway_url: gatewayUrl,
      protocol,
      run_id: run.run_id,
      session_id: run.session_id,
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
  protocol: RunWatchProtocol,
  run: GatewayRunRecord,
  events: number,
  interrupted: boolean
): void {
  if (jsonl) {
    writeLine(JSON.stringify({
      schema_version: RUN_WATCH_JSONL_VERSION,
      type: "watch_end",
      gateway_url: gatewayUrl,
      protocol,
      run_id: run.run_id,
      session_id: run.session_id,
      status: run.status,
      events,
      interrupted
    }));
    return;
  }
  writeLine(`watch ended: status=${run.status} events=${events}${interrupted ? " interrupted=true" : ""}`);
}

function isTerminalRunStatus(value: string): boolean {
  return value === "completed" || value === "failed";
}

function pollIntervalMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : RUN_STATUS_POLL_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
