export type RunGatewayCliReport = {
  detail: string;
  data: Record<string, unknown>;
};

type GatewayRunRecord = {
  run_id: string;
  session_id?: string;
  objective: string;
  mode: string;
  status: string;
  error?: string;
  result?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type { GatewayRunRecord };

export class RunGatewayError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly gatewayUrl: string,
    readonly runId?: string,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export async function listRunsViaGateway(input: {
  gatewayUrl?: string;
}): Promise<RunGatewayCliReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const runs = await listGatewayRunRecords(gatewayUrl);
  const detail = [
    "Swarm Runs",
    `gateway=${gatewayUrl}`,
    `summary total=${runs.length} running=${runs.filter((run) => run.status === "running" || run.status === "starting").length} completed=${runs.filter((run) => run.status === "completed").length} failed=${runs.filter((run) => run.status === "failed").length}`,
    "",
    ...(runs.length === 0
      ? ["No Gateway runs found."]
      : runs.flatMap((run) => [
          `${run.updated_at ?? run.created_at ?? "(unknown)"} [${run.status}] ${run.run_id} ${truncateText(run.objective, 96)}`,
          [
            `  mode=${run.mode}`,
            run.session_id ? `session=${run.session_id}` : undefined,
            run.error ? `error=${truncateText(run.error, 80)}` : undefined
          ].filter(Boolean).join(" ")
        ]))
  ].join("\n");
  return {
    detail,
    data: {
      gateway_url: gatewayUrl,
      summary: {
        total: runs.length,
        running: runs.filter((run) => run.status === "running" || run.status === "starting").length,
        completed: runs.filter((run) => run.status === "completed").length,
        failed: runs.filter((run) => run.status === "failed").length
      },
      runs
    }
  };
}

export async function showRunViaGateway(input: {
  gatewayUrl?: string;
  selector?: string;
}): Promise<RunGatewayCliReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const runs = await listGatewayRunRecords(gatewayUrl);
  const resolution = resolveRunSelector(runs, input.selector);
  if (!resolution.runId) {
    throw new Error(resolution.error ?? `Unknown run: ${input.selector ?? "(missing)"}`);
  }
  const run = await readGatewayRunRecord(gatewayUrl, resolution.runId);
  return {
    detail: [
      "Swarm Run",
      `gateway=${gatewayUrl}`,
      `run=${run.run_id} status=${run.status} mode=${run.mode}`,
      `session=${run.session_id ?? "(none)"} created=${run.created_at ?? "(unknown)"} updated=${run.updated_at ?? "(unknown)"}`,
      `objective=${run.objective}`,
      run.result ? `result_status=${stringValue(run.result.status) ?? "(unknown)"}` : "result_status=(none)",
      run.error ? `error=${run.error}` : undefined
    ].filter(Boolean).join("\n"),
    data: {
      gateway_url: gatewayUrl,
      run
    }
  };
}

export function isRunGatewayError(error: unknown): error is RunGatewayError {
  return error instanceof RunGatewayError;
}

export async function resolveGatewayRunRecord(gatewayUrl: string, selector?: string): Promise<GatewayRunRecord> {
  const runs = await listGatewayRunRecords(gatewayUrl);
  const resolution = resolveRunSelector(runs, selector);
  if (!resolution.runId) {
    throw new Error(resolution.error ?? `Unknown run: ${selector ?? "(missing)"}`);
  }
  return readGatewayRunRecord(gatewayUrl, resolution.runId);
}

type RunSelectorResolution = {
  runId?: string;
  error?: string;
};

function resolveRunSelector(runs: GatewayRunRecord[], query?: string): RunSelectorResolution {
  const trimmed = query?.trim();
  if (!trimmed || trimmed.toLowerCase() === "latest") {
    return runs[0]
      ? { runId: runs[0].run_id }
      : { error: "No Gateway runs found." };
  }
  const exact = runs.find((run) => run.run_id === trimmed);
  if (exact) {
    return { runId: exact.run_id };
  }
  const normalized = trimmed.toLowerCase();
  const prefixMatches = runs.filter((run) => run.run_id.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) {
    return { runId: prefixMatches[0].run_id };
  }
  if (prefixMatches.length > 1) {
    return { error: `Ambiguous run selector: ${trimmed}. Matches: ${prefixMatches.slice(0, 6).map((run) => run.run_id).join(", ")}` };
  }
  const fuzzyMatches = runs.filter((run) =>
    run.run_id.toLowerCase().includes(normalized)
    || run.objective.toLowerCase().includes(normalized)
    || (run.session_id?.toLowerCase().includes(normalized) ?? false)
  );
  if (fuzzyMatches.length === 1) {
    return { runId: fuzzyMatches[0].run_id };
  }
  if (fuzzyMatches.length > 1) {
    return { error: `Ambiguous run selector: ${trimmed}. Matches: ${fuzzyMatches.slice(0, 6).map((run) => run.run_id).join(", ")}` };
  }
  return { error: `Unknown run: ${trimmed}` };
}

export async function listGatewayRunRecords(gatewayUrl: string): Promise<GatewayRunRecord[]> {
  const payload = await getGatewayJson(gatewayUrl, "/v1/runs");
  const record = recordValue(payload);
  const runs = Array.isArray(record?.runs)
    ? record.runs.map(normalizeRunRecord).filter((run): run is GatewayRunRecord => Boolean(run))
    : undefined;
  if (!runs) {
    throw new RunGatewayError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, 200, gatewayUrl, undefined, payload);
  }
  return runs.sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""));
}

export async function readGatewayRunRecord(gatewayUrl: string, runId: string): Promise<GatewayRunRecord> {
  const payload = await getGatewayJson(gatewayUrl, `/v1/runs/${encodeURIComponent(runId)}`);
  const run = normalizeRunRecord(payload);
  if (!run) {
    throw new RunGatewayError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, 200, gatewayUrl, runId, payload);
  }
  return run;
}

function normalizeRunRecord(value: unknown): GatewayRunRecord | undefined {
  const record = recordValue(value);
  const runId = stringValue(record?.run_id);
  const objective = stringValue(record?.objective);
  const mode = stringValue(record?.mode);
  const status = stringValue(record?.status);
  if (!runId || !objective || !mode || !status) {
    return undefined;
  }
  return {
    run_id: runId,
    session_id: stringValue(record?.session_id),
    objective,
    mode,
    status,
    error: stringValue(record?.error),
    result: recordValue(record?.result),
    created_at: stringValue(record?.created_at),
    updated_at: stringValue(record?.updated_at)
  };
}

export function resolveGatewayUrl(value?: string): string {
  const fallback = process.env.SWARM_GATEWAY_URL?.trim() || "http://127.0.0.1:38171";
  const resolved = (value?.trim() || fallback).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(resolved)) {
    throw new Error(`Invalid gateway URL: ${resolved}`);
  }
  return resolved;
}

async function getGatewayJson(gatewayUrl: string, path: string): Promise<unknown> {
  const url = `${gatewayUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RunGatewayError(
      `Swarm Gateway is not reachable at ${gatewayUrl}. Start \`swarm serve\` or pass --gateway-url <url>. ${message}`,
      undefined,
      gatewayUrl
    );
  }
  const payload = await readGatewayJson(response);
  if (!response.ok) {
    throw new RunGatewayError(
      gatewayErrorMessage(payload, response.status),
      response.status,
      gatewayUrl,
      undefined,
      payload
    );
  }
  return payload;
}

async function readGatewayJson(response: Response): Promise<unknown> {
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

function truncateText(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, Math.max(0, limit - 1))}...`
    : value;
}
