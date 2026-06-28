import { gatewayClientAuthHeaders } from "../server/gateway-auth.js";
import { gatewayErrorMessage, recordValue, resolveGatewayUrl, stringValue } from "../server/gateway-client-utils.js";

export type HandoffGatewayControlReport = {
  detail: string;
  data: Record<string, unknown>;
};

export class HandoffGatewayControlError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly gatewayUrl: string,
    readonly handoffId: string,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export async function takeBackHandoffViaGateway(input: {
  gatewayUrl?: string;
  handoffId: string;
}): Promise<HandoffGatewayControlReport> {
  const gatewayUrl = resolveGatewayUrl(input.gatewayUrl);
  const payload = await postGatewayHandoffJson(gatewayUrl, input.handoffId, { });
  const record = recordValue(payload);
  const handoffId = stringValue(record?.handoff_id);
  const status = stringValue(record?.status);
  const workerId = stringValue(record?.worker_id);
  if (!handoffId || !status) {
    throw new HandoffGatewayControlError(`Unexpected Swarm Gateway response from ${gatewayUrl}.`, 202, gatewayUrl, input.handoffId, payload);
  }
  return {
    detail: [
      "Swarm Handoff Take-Back",
      `gateway=${gatewayUrl}`,
      `handoff=${handoffId}`,
      workerId ? `worker=${workerId}` : undefined,
      `status=${status}`
    ].filter(Boolean).join("\n"),
    data: {
      action: "take-back",
      gateway_url: gatewayUrl,
      handoff_id: handoffId,
      worker_id: workerId,
      status
    }
  };
}

export function isHandoffGatewayControlError(error: unknown): error is HandoffGatewayControlError {
  return error instanceof HandoffGatewayControlError;
}

async function postGatewayHandoffJson(
  gatewayUrl: string,
  handoffId: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const url = `${gatewayUrl}/v1/handoffs/${encodeURIComponent(handoffId)}/take-back`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...gatewayClientAuthHeaders() },
      body: JSON.stringify(body)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HandoffGatewayControlError(
      `Swarm Gateway is not reachable at ${gatewayUrl}. Start \`swarm serve\` or pass --gateway-url <url>. ${message}`,
      undefined,
      gatewayUrl,
      handoffId
    );
  }
  const payload = await readGatewayJson(response);
  if (!response.ok) {
    throw new HandoffGatewayControlError(
      gatewayErrorMessage(payload, response.status),
      response.status,
      gatewayUrl,
      handoffId,
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

