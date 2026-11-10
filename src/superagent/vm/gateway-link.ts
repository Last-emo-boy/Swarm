/**
 * The guest's side of a ticket VM's gateway (gateway.ts): the supervisor, the worker and its ticket tools in the VM reach
 * their ticket through it with the slot's token, as a worker on a paired node reaches the owner's work routes
 * (src/mesh/work-link.ts). The token names the slot, and the slot the ticket and Assignment it runs.
 */
import type { WorkerReport } from "../core/index.js";
import { proxiedTicketTools, type ReportArgs, type TicketTool } from "../ticket-tools.js";
import type { WorkLink, WorkStart, WorkView } from "../work-link.js";

/** Where the guest finds its gateway and its token: the supervisor sets both for the worker and its tools. */
export const GATEWAY_VARIABLE = "SWARM_GUEST_GATEWAY", TOKEN_VARIABLE = "SWARM_GUEST_TOKEN";
/** Tries of a call the gateway does not answer, 2 to 32 seconds apart: a restart of the host takes up to a minute. */
const TRIES = 6;
/** How long a ticket tool may take on the host, within the worker's 120-second limit for a tool call. */
const TOOL_TIMEOUT_MS = 110_000;
const CALL_TIMEOUT_MS = 30_000;

export class GatewayError extends Error {
  /** The gateway's HTTP status, or 0 when it did not answer. */
  constructor(message: string, readonly status: number) { super(message); }
}

export interface Gateway { url: string; token: string }

export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): Gateway {
  const url = env[GATEWAY_VARIABLE], token = env[TOKEN_VARIABLE];
  if (!url || !token) throw new Error(`${GATEWAY_VARIABLE} and ${TOKEN_VARIABLE} are not set; the ticket VM's supervisor starts this command`);
  return { url: url.replace(/\/$/, ""), token };
}

/**
 * Calls the gateway, again after a moment while it does not answer, as while the host restarts. A ticket tool runs once:
 * one that timed out may have run.
 */
export async function callGateway<T>(gateway: Gateway, method: string, path: string, body?: unknown, tool = false): Promise<T> {
  const tries = tool ? 1 : TRIES;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${gateway.url}${path}`, {
        method, headers: { authorization: `Bearer ${gateway.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(tool ? TOOL_TIMEOUT_MS : CALL_TIMEOUT_MS)
      });
    } catch (error) {
      if (attempt >= tries) throw new GatewayError(`The ticket VM's gateway did not answer: ${error instanceof Error ? error.message : String(error)}`, 0);
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: { message: text.slice(0, 500) } }; }
    if (response.ok) return parsed as T;
    const message = (parsed as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`;
    throw new GatewayError(message, response.status);
  }
}

/** The link of the worker in the VM to its ticket, for the Assignment its slot holds. */
export function gatewayLink(gateway: Gateway, ticketId: string): WorkLink {
  const post = async (path: string, body: Record<string, unknown> = {}): Promise<void> => { await callGateway(gateway, "POST", `/v1/work/${path}`, body); };
  return {
    // A token whose lease ended reads nothing, as a worker whose Assignment ended reads no ticket.
    view: async () => {
      try {
        return (await callGateway<{ view: WorkView | null }>(gateway, "GET", "/v1/work")).view ?? undefined;
      } catch (error) {
        if (error instanceof GatewayError && error.status === 401) return undefined;
        throw error;
      }
    },
    start: () => callGateway<WorkStart>(gateway, "GET", `/v1/work/start?directory=${encodeURIComponent(process.cwd())}`),
    delivered: (inputIds) => post("delivered", { inputIds }),
    turnEnded: () => post("turn"),
    report: (report: WorkerReport) => post("report", { report }),
    fileReport: async (args: ReportArgs) => { await callGateway(gateway, "POST", "/v1/work/tools/report", { args }, true); },
    tools: {
      args: ["superagent", "mcp", "--ticket", ticketId, "--gateway"],
      env: { [GATEWAY_VARIABLE]: gateway.url, [TOKEN_VARIABLE]: gateway.token }
    },
    close: () => {}
  };
}

/** The ticket tools of the worker in the VM, each run by the host. */
export function gatewayTicketTools(gateway: Gateway): TicketTool[] {
  return proxiedTicketTools(async (name, args) =>
    (await callGateway<{ result: unknown }>(gateway, "POST", `/v1/work/tools/${encodeURIComponent(name)}`, { args }, true)).result);
}
