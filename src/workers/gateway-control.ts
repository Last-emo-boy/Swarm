import { gatewayClientAuthHeaders } from "../server/gateway-auth.js";
import { gatewayErrorMessage, recordValue, resolveGatewayUrl, stringValue } from "../server/gateway-client-utils.js";

export type WorkerGatewayControlReport = {
  detail: string;
  data: Record<string, unknown>;
};

type WorkerGatewayRoute = "stop" | "continue";

export class WorkerGatewayControlError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly gatewayUrl: string,
    readonly workerId: string,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export async function stopWorkerViaGateway(input: {
  gatewayUrl?: string;
  workerId: string;
}): Promise<WorkerGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = await postGatewayWorkerJson(gatewayUrl, input.workerId, "stop", {});
  const record = recordValue(payload);
  const workerId = stringValue(record?.worker_id);
  const status = stringValue(record?.status);
  if (!workerId || !status) {
    throw new WorkerGatewayControlError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, 202, gatewayUrl, input.workerId, payload);
  }
  return {
    detail: [
      "Swarm Worker Stop",
      `gateway=${gatewayUrl}`,
      `worker=${workerId}`,
      `status=${status}`
    ].join("\n"),
    data: {
      action: "stop",
      gateway_url: gatewayUrl,
      worker_id: workerId,
      status
    }
  };
}

export async function continueWorkerViaGateway(input: {
  gatewayUrl?: string;
  workerId: string;
  message: string;
}): Promise<WorkerGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = await postGatewayWorkerJson(gatewayUrl, input.workerId, "continue", { message: input.message });
  const record = recordValue(payload);
  const workerId = stringValue(record?.worker_id);
  const result = recordValue(record?.result);
  if (!workerId || !result) {
    throw new WorkerGatewayControlError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, 200, gatewayUrl, input.workerId, payload);
  }
  return {
    detail: [
      "Swarm Worker Continue",
      `gateway=${gatewayUrl}`,
      `worker=${workerId}`,
      `result_status=${stringValue(result.status) ?? "(unknown)"}`,
      `summary=${stringValue(result.summary) ?? "(none)"}`,
      `message=${input.message}`
    ].join("\n"),
    data: {
      action: "continue",
      gateway_url: gatewayUrl,
      worker_id: workerId,
      message: input.message,
      result
    }
  };
}

export function isWorkerGatewayControlError(error: unknown): error is WorkerGatewayControlError {
  return error instanceof WorkerGatewayControlError;
}

async function postGatewayWorkerJson(
  gatewayUrl: string,
  workerId: string,
  action: WorkerGatewayRoute,
  body: Record<string, unknown>
): Promise<unknown> {
  const url = `${gatewayUrl}/v1/workers/${encodeURIComponent(workerId)}/${action}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...gatewayClientAuthHeaders() },
      body: JSON.stringify(body)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkerGatewayControlError(
      `Swarm Gateway is not reachable at ${gatewayUrl}. Start \`swarm serve\` or pass --gateway-url <url>. ${message}`,
      undefined,
      gatewayUrl,
      workerId
    );
  }
  const payload = await readGatewayJson(response);
  if (!response.ok) {
    throw new WorkerGatewayControlError(
      gatewayErrorMessage(payload, response.status),
      response.status,
      gatewayUrl,
      workerId,
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

