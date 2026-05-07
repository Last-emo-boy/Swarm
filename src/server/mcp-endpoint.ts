import type { IncomingMessage, ServerResponse } from "node:http";
import type { SwarmRuntime } from "../runtime/runtime.js";
import type { RunMode } from "../runtime/execution-router.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type McpEndpointOptions = {
  runtime: SwarmRuntime;
  request: IncomingMessage;
  response: ServerResponse;
  body: unknown;
  startRun: (objective: string, mode: RunMode) => Promise<{ run_id: string; session_id?: string; status: string }>;
  interrupt: (sessionId: string | undefined, content: string) => void;
  approvalDecision: (approvalId: string, approved: boolean) => boolean;
};

const SWARM_MCP_TOOLS = [
  {
    name: "swarm.start_session",
    title: "Start Swarm Session",
    description: "Start a Swarm run through the local Gateway.",
    inputSchema: objectSchema({
      objective: { type: "string", description: "User objective for Swarm." },
      mode: { type: "string", description: "auto, chat, coding_loop, or full_swarm." }
    })
  },
  {
    name: "swarm.send_message",
    title: "Send Message",
    description: "Send a live message to the active Swarm session.",
    inputSchema: objectSchema({
      content: { type: "string", description: "Message content." },
      session_id: { type: "string", description: "Optional target session id." }
    })
  },
  {
    name: "swarm.interrupt",
    title: "Interrupt Swarm",
    description: "Interrupt the active Swarm run and ask it to reassess.",
    inputSchema: objectSchema({
      content: { type: "string", description: "Interrupt message." },
      session_id: { type: "string", description: "Optional target session id." }
    })
  },
  {
    name: "swarm.approval_decision",
    title: "Approval Decision",
    description: "Approve or deny one pending Gateway approval.",
    inputSchema: objectSchema({
      approval_id: { type: "string", description: "Approval id." },
      approved: { type: "boolean", description: "Whether to approve the request." }
    })
  },
  {
    name: "swarm.session_status",
    title: "Session Status",
    description: "Read recent Swarm session and run status.",
    inputSchema: objectSchema({
      session_id: { type: "string", description: "Optional session id." },
      limit: { type: "number", description: "Recent session limit." }
    }),
    annotations: { readOnlyHint: true }
  }
];

export async function handleSwarmMcpEndpoint(options: McpEndpointOptions): Promise<void> {
  if (!options.runtime.settings.extensions.mcp.exposeGatewayServer) {
    sendMcpHttpError(options.response, 404, "Swarm MCP server is disabled.");
    return;
  }
  if (options.request.method === "GET") {
    sendJson(options.response, 200, {
      service: "swarm-mcp",
      transport: "streamable-http-json",
      status: "enabled"
    });
    return;
  }
  if (options.request.method !== "POST") {
    sendMcpHttpError(options.response, 405, "Method not allowed.");
    return;
  }

  const requests = Array.isArray(options.body) ? options.body : [options.body];
  const responses = await Promise.all(requests.map((request) => handleMcpRequest(options, request)));
  const payload = Array.isArray(options.body) ? responses.filter(Boolean) : responses[0];
  if (Array.isArray(payload) && payload.length === 0) {
    options.response.writeHead(204);
    options.response.end();
    return;
  }
  if (payload === undefined) {
    options.response.writeHead(204);
    options.response.end();
    return;
  }
  sendJson(options.response, 200, payload);
}

async function handleMcpRequest(options: McpEndpointOptions, rawRequest: unknown): Promise<Record<string, unknown> | undefined> {
  const request = isRecord(rawRequest) ? rawRequest as JsonRpcRequest : undefined;
  const id = request?.id ?? null;
  try {
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return jsonRpcError(id, -32600, "Invalid Request");
    }
    if (request.method === "initialize") {
      return jsonRpcResult(id, {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {},
          resources: {},
          prompts: {}
        },
        serverInfo: {
          name: "swarm-gateway",
          version: "0.1.0"
        },
        instructions: "Local Swarm Gateway MCP endpoint. Exposes selected Swarm controls and read-only status resources."
      });
    }
    if (request.method === "notifications/initialized") {
      return undefined;
    }
    if (request.method === "tools/list") {
      return jsonRpcResult(id, { tools: SWARM_MCP_TOOLS });
    }
    if (request.method === "tools/call") {
      return jsonRpcResult(id, await callSwarmTool(options, request.params));
    }
    if (request.method === "resources/list") {
      return jsonRpcResult(id, { resources: listSwarmResources(options.runtime) });
    }
    if (request.method === "resources/read") {
      return jsonRpcResult(id, readSwarmResource(options.runtime, request.params));
    }
    if (request.method === "prompts/list") {
      return jsonRpcResult(id, { prompts: listSwarmPrompts() });
    }
    if (request.method === "prompts/get") {
      return jsonRpcResult(id, getSwarmPrompt(request.params));
    }
    if (request.method === "ping") {
      return jsonRpcResult(id, {});
    }
    return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    return jsonRpcError(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

async function callSwarmTool(options: McpEndpointOptions, params: unknown): Promise<Record<string, unknown>> {
  const input = isRecord(params) ? params : {};
  const name = typeof input.name === "string" ? input.name : "";
  const args = isRecord(input.arguments) ? input.arguments : {};
  if (name === "swarm.start_session") {
    const objective = stringArg(args, "objective");
    const mode = runModeArg(args.mode);
    const run = await options.startRun(objective, mode);
    return textToolResult(`Started ${run.run_id}${run.session_id ? ` session=${run.session_id}` : ""} status=${run.status}`, run);
  }
  if (name === "swarm.send_message") {
    const content = stringArg(args, "content");
    await options.runtime.sendUserMessage(content);
    return textToolResult("Message queued.", { status: "queued", session_id: optionalString(args.session_id) });
  }
  if (name === "swarm.interrupt") {
    const content = optionalString(args.content) ?? "Interrupted through Swarm MCP endpoint.";
    options.interrupt(optionalString(args.session_id), content);
    return textToolResult("Interrupt queued.", { status: "interrupt_queued" });
  }
  if (name === "swarm.approval_decision") {
    const approvalId = stringArg(args, "approval_id");
    const approved = args.approved === true;
    const found = options.approvalDecision(approvalId, approved);
    return textToolResult(found ? "Approval decision applied." : "Approval was not pending.", { approval_id: approvalId, approved, found });
  }
  if (name === "swarm.session_status") {
    const sessionId = optionalString(args.session_id);
    const limit = positiveInteger(args.limit, 10);
    const data = sessionId
      ? sessionSnapshot(options.runtime, sessionId)
      : {
          sessions: options.runtime.sessionStore.listRecent(limit),
          workers: options.runtime.workerStateStore.listRecent(limit),
          mcp_servers: options.runtime.listMcpServers()
        };
    return textToolResult(JSON.stringify(data, null, 2), data);
  }
  throw new Error(`Unknown Swarm MCP tool: ${name}`);
}

function listSwarmResources(runtime: SwarmRuntime): unknown[] {
  return runtime.sessionStore.listRecent(20).flatMap((session) => [
    {
      uri: `swarm://sessions/${session.session_id}`,
      name: `session ${session.session_id}`,
      title: session.objective,
      description: `Swarm session ${session.status}`,
      mimeType: "application/json"
    },
    {
      uri: `swarm://sessions/${session.session_id}/events`,
      name: `events ${session.session_id}`,
      description: "Recent runtime events for this Gateway process.",
      mimeType: "application/json"
    },
    {
      uri: `swarm://sessions/${session.session_id}/trace`,
      name: `trace ${session.session_id}`,
      description: "Persisted trace envelopes.",
      mimeType: "application/json"
    },
    {
      uri: `swarm://sessions/${session.session_id}/audit`,
      name: `audit ${session.session_id}`,
      description: "Persisted audit records.",
      mimeType: "application/json"
    }
  ]);
}

function readSwarmResource(runtime: SwarmRuntime, params: unknown): Record<string, unknown> {
  const input = isRecord(params) ? params : {};
  const uri = stringArg(input, "uri");
  const parsed = /^swarm:\/\/sessions\/([^/]+)(?:\/(events|trace|audit))?$/.exec(uri);
  if (!parsed) {
    throw new Error(`Unsupported Swarm resource URI: ${uri}`);
  }
  const sessionId = parsed[1];
  const section = parsed[2];
  let value: unknown;
  if (section === "events") {
    value = runtime.replaySession(sessionId);
  } else if (section === "trace") {
    value = runtime.traceStore.list(sessionId);
  } else if (section === "audit") {
    value = runtime.auditStore.list(sessionId, 200);
  } else {
    value = sessionSnapshot(runtime, sessionId);
  }
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function listSwarmPrompts(): unknown[] {
  return [
    {
      name: "swarm_self_review",
      title: "Swarm Self Review",
      description: "Ask Swarm to inspect its own recent behavior."
    },
    {
      name: "swarm_code_review",
      title: "Swarm Code Review",
      description: "Ask Swarm for a focused code review.",
      arguments: [{ name: "focus", description: "Optional review focus.", required: false }]
    },
    {
      name: "swarm_symphony_work_item",
      title: "Symphony Work Item",
      description: "Draft a Symphony-compatible work item prompt.",
      arguments: [{ name: "objective", description: "Work item objective.", required: true }]
    }
  ];
}

function getSwarmPrompt(params: unknown): Record<string, unknown> {
  const input = isRecord(params) ? params : {};
  const name = stringArg(input, "name");
  const args = isRecord(input.arguments) ? input.arguments : {};
  if (name === "swarm_self_review") {
    return promptResult("Review recent Swarm runs, failures, tool results, approvals, and traces. Return findings, risks, and concrete next improvements.");
  }
  if (name === "swarm_code_review") {
    const focus = optionalString(args.focus);
    return promptResult(`Review the current workspace diff for bugs, regressions, missing tests, and risky assumptions.${focus ? ` Focus: ${focus}.` : ""}`);
  }
  if (name === "swarm_symphony_work_item") {
    return promptResult(`Create or refine a Symphony work item for this objective:\n${stringArg(args, "objective")}`);
  }
  throw new Error(`Unknown Swarm prompt: ${name}`);
}

function promptResult(text: string): Record<string, unknown> {
  return {
    messages: [
      {
        role: "user",
        content: { type: "text", text }
      }
    ]
  };
}

function textToolResult(text: string, data?: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    structuredContent: data && isRecord(data) ? data : undefined
  };
}

function sessionSnapshot(runtime: SwarmRuntime, sessionId: string): Record<string, unknown> {
  const row = runtime.sessionStore.get(sessionId);
  if (!row) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return {
    ...row,
    participants: parseJson(row.participants_json),
    policy: parseJson(row.policy_json),
    plan: row.plan_json ? parseJson(row.plan_json) : undefined,
    graph: runtime.getTaskGraph(sessionId),
    usage_summary: runtime.usageStore.summarize(sessionId)
  };
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties };
}

function jsonRpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendMcpHttpError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(jsonRpcError(null, -32000, message), null, 2)}\n`);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function runModeArg(value: unknown): RunMode {
  if (value === "chat" || value === "coding_loop" || value === "full_swarm") {
    return value;
  }
  return "auto";
}

function stringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing string argument: ${key}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
