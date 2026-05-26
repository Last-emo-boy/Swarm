import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { BlackboardEntry, WorkItem } from "../protocol/types.js";
import { consumeGatewaySessionStream } from "../runtime/gateway-event-stream.js";
import type { WorkProtocolRecord } from "../runtime/work-protocol.js";
import { gatewayClientAuthHeaders } from "./gateway-auth.js";
import { SwarmGatewayServer } from "./gateway.js";
import { sanitizeWorkspaceKey } from "../symphony/workspace.js";

test("Gateway exposes Symphony status through a real HTTP route", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const health = await readJson<GatewayHealthPayload>(`${started.url}/health`);
    assert.equal(health.ok, true);
    assert(Array.isArray(health.routes));
    assert(health.routes.includes("/v1/symphony/status"));

    const status = await readJson<SymphonyStatusPayload>(`${started.url}/v1/symphony/status?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(status.workflow.ok, true);
    assert.equal(status.workflow.workflow.path, fixture.workflowPath);
    assert.equal(status.live_control.status, "idle");
    assert.equal(status.live_control.severity, "hidden");
    assert.equal(status.scheduler.capacity.max_concurrent, 2);
    assert.deepEqual(status.totals, {
      sessions: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      retrying: 0
    });
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony status returns a JSON error for missing workflow", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const response = await fetch(`${started.url}/v1/symphony/status?workflow=${encodeURIComponent(join(fixture.root, "missing-WORKFLOW.md"))}`);
    const body = await response.json() as { error?: { status?: number; message?: string } };

    assert.equal(response.status, 400);
    assert.equal(body.error?.status, 400);
    assert.match(body.error?.message ?? "", /missing_workflow_file/);
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony cleanup dry-run is available through local-control auth", async () => {
  const fixture = createFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const response = await fetch(`${started.url}/v1/symphony/cleanup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gatewayClientAuthHeaders()
      },
      body: JSON.stringify({
        workflow_path: fixture.workflowPath,
        execute: false
      })
    });
    const body = await response.json() as {
      execute?: boolean;
      inspected?: number;
      removed?: number;
      workflow?: { ok?: boolean };
    };

    assert.equal(response.status, 200);
    assert.equal(body.workflow?.ok, true);
    assert.equal(body.execute, false);
    assert.equal(body.inspected, 0);
    assert.equal(body.removed, 0);
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony preview exposes normalized product-surface evidence through the real HTTP route", async () => {
  const fixture = createPreviewFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const response = await fetch(`${started.url}/v1/symphony/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gatewayClientAuthHeaders()
      },
      body: JSON.stringify({
        workflow_path: fixture.workflowPath,
        create_workspace: false
      })
    });
    const body = await response.json() as PreviewResponse;

    assert.equal(response.status, 201);
    assert.equal(body.workflow.path, fixture.workflowPath);
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.items.map((item) => item.human_id).sort(), ["WK-101", "WK-102"]);
    assert.equal(body.items.some((item) => item.human_id === "WK-103"), false);
    for (const item of body.items) {
      assert.equal(item.source, "symphony");
      assert.equal(item.state, "Todo");
      assert.deepEqual(item.labels, ["local"]);
      assert.equal(item.metadata.work_source_kind, "local");
      assert.equal(item.metadata.local_path, fixture.workItemsPath);
    }

    assert.equal(body.sessions.length, 2);
    const itemByObjective = new Map(body.items.map((item) => [previewObjective(item), item] as const));
    for (const preview of body.sessions) {
      const sessionSnapshot = recordValue(preview.session);
      const objective = stringValue(sessionSnapshot.objective, "session objective");
      const workItem = itemByObjective.get(objective);
      assert(workItem, `Missing preview work item for objective: ${objective}`);
      const sessionId = stringValue(sessionSnapshot.session_id, "session_id");
      const workspaceLeaseId = stringValue(sessionSnapshot.workspace_lease_id, "workspace_lease_id");
      const sourceJson = stringValue(sessionSnapshot.source_json, "session source_json");
      assert.equal(sessionSnapshot.status, "created");
      assert.equal(preview.prompt, previewPrompt(workItem));
      assert.equal(preview.workspace_path, resolve(fixture.workspaceRoot, sanitizeWorkspaceKey(workItem.human_id ?? workItem.source_id ?? workItem.title)));

      const source = parseJson<WorkItem>(sourceJson, "session source_json");
      assert.deepEqual(source, workItem);

      const workSnapshot = recordValue(sessionSnapshot.work_snapshot);
      const workSnapshotSession = recordValue(workSnapshot.session);
      assert.deepEqual(workSnapshotSession.source, workItem);

      const lease = server.runtime.workspaceLeaseStore.get(workspaceLeaseId);
      assert(lease, "missing WorkspaceLease row");
      assert.equal(lease.session_id, sessionId);
      assert.equal(lease.workspace_root, resolve(fixture.workspaceRoot));
      assert.equal(lease.workspace_path, preview.workspace_path);
      assert.equal(lease.write_boundary, "workspace");
      assert.equal(lease.metadata.kind, "symphony_workspace");
      assert.equal(lease.metadata.workspace_key, sanitizeWorkspaceKey(workItem.human_id ?? workItem.source_id ?? workItem.title));
      assert.deepEqual(lease.metadata.work_item, workItem);
      assert.equal(existsSync(preview.workspace_path), false, "create_workspace=false should not create the per-item workspace path");

      const entries = server.runtime.blackboardStore.list(sessionId).filter((entry) => entry.key === "symphony.preview");
      assert.equal(entries.length, 1);
      assertPreviewEntry(entries[0], {
        workflowPath: fixture.workflowPath,
        workItem,
        workspacePath: preview.workspace_path
      });
    }

    const sessionRows = server.runtime.sessionStore.listBySource("symphony");
    assert.equal(sessionRows.length, 2);
    assert.deepEqual(sessionRows.map((row) => row.status).sort(), ["created", "created"]);
    assert.deepEqual(
      sessionRows.map((row) => parseJson<WorkItem>(row.source_json, "stored session source").human_id).sort(),
      ["WK-101", "WK-102"]
    );
    assert.equal(
      sessionRows.some((row) => parseJson<WorkItem>(row.source_json, "stored session source").human_id === "WK-103"),
      false
    );
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway/Symphony smoke aligns preview sessions, work streams, approvals, and MCP surfaces", async () => {
  const fixture = createPreviewFixture();
  const oldToken = process.env.SWARM_GATEWAY_TOKEN;
  delete process.env.SWARM_GATEWAY_TOKEN;
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  server.runtime.settings.extensions.mcp.enabled = true;
  server.runtime.settings.extensions.mcp.exposeGatewayServer = true;

  const streamMessages: Array<{ event: string; data: unknown; sequence?: number }> = [];
  const streamAbort = new AbortController();
  let streamTimeout: NodeJS.Timeout | undefined;
  try {
    const started = await server.start();
    const stream = consumeGatewaySessionStream({
      gatewayUrl: started.url,
      protocol: "work",
      signal: streamAbort.signal,
      shouldStop: () =>
        streamMessages.some((message) => message.event === "session") &&
        streamMessages.some((message) => message.event === "runtime_event"),
      onMessage: (message) => streamMessages.push(message)
    });
    streamTimeout = setTimeout(() => streamAbort.abort(), 5_000);

    const preview = await postJson<PreviewResponse>(`${started.url}/v1/symphony/preview`, {
      workflow_path: fixture.workflowPath,
      create_workspace: false
    }, 201);
    const streamSummary = await stream;

    assert.equal(preview.items.length, 2);
    assert.equal(preview.sessions.length, 2);
    assert(streamSummary.events >= 2, `expected stream events, got ${streamSummary.events}`);
    const workRecords = streamMessages.map((message) => message.data).filter(isWorkRecord);
    assert(workRecords.some((record) => record.kind === "session" && record.status === "created"));
    assert(workRecords.some((record) => record.kind === "runtime_event" && record.event_type === "blackboard"));

    const previewSessionIds = preview.sessions.map((item) =>
      stringValue(recordValue(item.session).session_id, "preview session_id")
    );
    const sessionId = previewSessionIds[0];
    const sessionView = await readJson<SessionSmokeViewPayload>(`${started.url}/v1/sessions/${encodeURIComponent(sessionId)}`);
    assert.equal(sessionView.session_id, sessionId);
    assert.equal(sessionView.live_control.status, "running");
    assert.equal(sessionView.live_control.severity, "info");
    assert.equal(sessionView.work_snapshot.session.session_id, sessionId);
    assert.equal(sessionView.work_snapshot.session.source?.source, "symphony");
    assert.equal(sessionView.work_board.schema_version, "swarm.work_board.v1");
    assert.equal(sessionView.work_board.summary.sessions, 1);
    assert.equal(sessionView.work_board.sessions[0]?.session_id, sessionId);
    assert.equal(sessionView.approvals.summary.actionable_pending, 0);
    assert.equal(sessionView.approvals.summary.persisted_pending, 0);

    const status = await readJson<SymphonyStatusPayload>(`${started.url}/v1/symphony/status?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(status.live_control.status, "running");
    assert.equal(status.live_control.severity, "info");
    assert(status.totals.sessions >= previewSessionIds.length);
    assert(status.totals.running >= previewSessionIds.length);
    assert.equal(status.work_board.schema_version, "swarm.work_board.v1");
    assert.equal(status.work_board.summary.sessions, status.totals.sessions);
    const statusSessionIds = new Set(status.sessions.map((session) => session.session_id));
    for (const id of previewSessionIds) {
      assert(statusSessionIds.has(id), `missing preview session in Symphony status: ${id}`);
    }
    assert.equal(status.scheduler.capacity.max_concurrent, 2);
    assert(status.scheduler.capacity.running >= previewSessionIds.length);
    assert.equal(status.scheduler.capacity.available, Math.max(0, status.scheduler.capacity.max_concurrent - status.scheduler.capacity.running));

    const workspaceBoard = await readJson<WorkBoardPayload>(`${started.url}/v1/work-board?limit=20`);
    assert.equal(workspaceBoard.schema_version, "swarm.work_board.v1");
    assert(workspaceBoard.summary.sessions >= previewSessionIds.length);
    assert(previewSessionIds.every((id) => workspaceBoard.sessions.some((session) => session.session_id === id)));

    const sessionBoard = await readJson<WorkBoardPayload>(`${started.url}/v1/work-board/${encodeURIComponent(sessionId)}`);
    assert.equal(sessionBoard.schema_version, "swarm.work_board.v1");
    assert.equal(sessionBoard.summary.sessions, 1);
    assert.equal(sessionBoard.sessions[0]?.session_id, sessionId);

    const approvals = await readJson<ApprovalQueuePayload>(`${started.url}/v1/approvals?session_id=${encodeURIComponent(sessionId)}`);
    assert.deepEqual(approvals.summary, {
      actionable_pending: 0,
      persisted_pending: 0,
      approved: 0,
      denied: 0
    });

    const mcpHealth = await readJson<{ service: string; status: string }>(`${started.url}/mcp`);
    assert.equal(mcpHealth.service, "swarm-mcp");
    assert.equal(mcpHealth.status, "enabled");
    const tools = await postMcp<McpToolsListResult>(started.url, {
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list"
    });
    assert(tools.result?.tools.some((tool) => tool.name === "swarm.session_status"));
    assert(tools.result?.tools.some((tool) => tool.name === "swarm.approvals"));
    assert(tools.result?.tools.some((tool) => tool.name === "swarm.work_board"));

    const mcpSession = await postMcp<McpToolCallResult>(started.url, {
      jsonrpc: "2.0",
      id: "session-status",
      method: "tools/call",
      params: {
        name: "swarm.session_status",
        arguments: { session_id: sessionId, limit: 20 }
      }
    });
    const mcpSessionStatus = recordValue(mcpSession.result?.structuredContent);
    assert.equal(mcpSessionStatus.session_id, sessionId);
    assert.equal(recordValue(mcpSessionStatus.live_control).status, "running");
    assert.equal(recordValue(mcpSessionStatus.approvals).summary && recordValue(recordValue(mcpSessionStatus.approvals).summary).actionable_pending, 0);

    const mcpBoard = await postMcp<McpToolCallResult>(started.url, {
      jsonrpc: "2.0",
      id: "work-board",
      method: "tools/call",
      params: {
        name: "swarm.work_board",
        arguments: { session_id: sessionId, limit: 20 }
      }
    });
    const mcpBoardStatus = recordValue(mcpBoard.result?.structuredContent);
    assert.equal(mcpBoardStatus.schema_version, "swarm.work_board.v1");
    assert.equal(recordValue(mcpBoardStatus.summary).sessions, 1);

    const mcpApprovals = await postMcp<McpToolCallResult>(started.url, {
      jsonrpc: "2.0",
      id: "approvals",
      method: "tools/call",
      params: {
        name: "swarm.approvals",
        arguments: { session_id: sessionId, limit: 20 }
      }
    });
    assert.equal(recordValue(recordValue(mcpApprovals.result?.structuredContent).summary).actionable_pending, 0);
  } finally {
    if (streamTimeout) {
      clearTimeout(streamTimeout);
    }
    streamAbort.abort();
    await server.stop();
    fixture.close();
    if (oldToken === undefined) {
      delete process.env.SWARM_GATEWAY_TOKEN;
    } else {
      process.env.SWARM_GATEWAY_TOKEN = oldToken;
    }
  }
});

test("Gateway work event stream resumes from Last-Event-ID and reports replay gaps", async () => {
  const fixture = createPreviewFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    await postJson<PreviewResponse>(`${started.url}/v1/symphony/preview`, {
      workflow_path: fixture.workflowPath,
      create_workspace: false
    }, 201);

    const firstMessages: Array<{ event: string; data: unknown; sequence?: number }> = [];
    const firstAbort = new AbortController();
    const first = await consumeGatewaySessionStream({
      gatewayUrl: started.url,
      protocol: "work",
      signal: firstAbort.signal,
      shouldStop: () => firstMessages.length >= 2,
      onMessage: (message) => firstMessages.push(message)
    });
    firstAbort.abort();

    const lastEventId = first.lastEventId;
    assert(lastEventId, "expected initial stream cursor");
    assert(firstMessages.every((message) => typeof message.sequence === "number" && message.sequence > 0));

    const resumedMessages: Array<{ event: string; data: unknown; sequence?: number }> = [];
    const resumedAbort = new AbortController();
    const resumed = await consumeGatewaySessionStream({
      gatewayUrl: started.url,
      protocol: "work",
      lastEventId,
      signal: resumedAbort.signal,
      shouldStop: () => true,
      onMessage: (message) => resumedMessages.push(message)
    });
    resumedAbort.abort();

    assert.equal(resumed.events, 0);
    assert.equal(resumedMessages.length, 0);
    assert.equal(resumed.lastEventId, lastEventId);
    assert.equal(resumed.missedEventsHint, undefined);

    for (let index = 0; index < 505; index += 1) {
      server.runtime.events.emitEvent({ type: "log", level: "info", message: `overflow ${index}` });
    }
    const missedAbort = new AbortController();
    const missed = await consumeGatewaySessionStream({
      gatewayUrl: started.url,
      protocol: "work",
      lastEventId: 0,
      signal: missedAbort.signal,
      shouldStop: () => true,
      onMessage: () => undefined
    });
    missedAbort.abort();
    assert.equal(missed.missedEventsHint?.missed, true);
    assert.equal(missed.missedEventsHint?.requested_last_event_id, 0);
    assert(missed.missedEventsHint?.oldest_replayable_event_id && missed.missedEventsHint.oldest_replayable_event_id > 1);
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony operator cancel updates session state and work event stream", async () => {
  const fixture = createPreviewFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  const streamMessages: Array<{ event: string; data: unknown; sequence?: number }> = [];
  const streamAbort = new AbortController();
  let streamTimeout: NodeJS.Timeout | undefined;
  try {
    const started = await server.start();
    const preview = await postJson<PreviewResponse>(`${started.url}/v1/symphony/preview`, {
      workflow_path: fixture.workflowPath,
      create_workspace: false
    }, 201);
    const sessionId = stringValue(recordValue(preview.sessions[0].session).session_id, "preview session_id");

    const stream = consumeGatewaySessionStream({
      gatewayUrl: started.url,
      sessionId,
      protocol: "work",
      signal: streamAbort.signal,
      shouldStop: () => {
        const records = streamMessages.map((message) => message.data).filter(isWorkRecord);
        return records.some((record) => record.kind === "session" && record.status === "cancelled") &&
          records.some((record) => record.kind === "task" && record.task_id === "symphony.operator.cancel" && record.result_status === "success");
      },
      onMessage: (message) => streamMessages.push(message)
    });
    streamTimeout = setTimeout(() => streamAbort.abort(), 5_000);

    const cancel = await postJson<SymphonyActionResponse>(`${started.url}/v1/symphony/actions`, {
      action: "cancel",
      session_id: sessionId,
      action_id: "action-cancel-1",
      correlation_id: "corr-cancel-1",
      reason: "operator smoke"
    }, 202);
    const streamSummary = await stream;

    assert.equal(cancel.schema_version, "swarm.gateway.response.v1");
    assert.equal(cancel.action_id, "action-cancel-1");
    assert.equal(cancel.correlation_id, "corr-cancel-1");
    assert.equal(cancel.action, "cancel");
    assert.equal(cancel.status, "cancelled");
    assert.equal(cancel.session_id, sessionId);
    assert.equal(cancel.previous_status, "created");
    assert.equal(cancel.next_status, "cancelled");
    assert.equal(cancel.live_stop_requested, false);
    assert.equal(recordValue(cancel.session).status, "cancelled");
    assert.equal(server.runtime.sessionStore.get(sessionId)?.status, "cancelled");
    const gatewayEnvelopeId = stringValue(cancel.gateway_envelope_id, "cancel.gateway_envelope_id");

    const attempts = server.runtime.runAttemptStore.listByTask(sessionId, "symphony.operator.cancel");
    const operatorAttempt = attempts.find((attempt) => attempt.runner_id === "gateway.symphony.operator");
    const toolResultAttempt = attempts.find((attempt) => attempt.runner_id === "symphony.cancel");
    assert(operatorAttempt, "missing Gateway operator cancel attempt");
    assert(toolResultAttempt, "missing tool-result cancel attempt");
    assert.equal(operatorAttempt.status, "cancelled");
    assert.equal(operatorAttempt.terminal_reason, "operator smoke");
    assert.equal(recordValue(operatorAttempt.metadata).previous_status, "created");
    const attemptActionFact = recordValue(recordValue(operatorAttempt.metadata).action_fact);
    assert.equal(attemptActionFact.schema_version, "symphony.action.v1");
    assert.equal(attemptActionFact.action_id, "action-cancel-1");
    assert.equal(attemptActionFact.correlation_id, "corr-cancel-1");
    assert.equal(attemptActionFact.gateway_envelope_id, gatewayEnvelopeId);
    assert.equal(attemptActionFact.status, "applied");
    assert.equal(recordValue(operatorAttempt.metadata).gateway_envelope_id, gatewayEnvelopeId);
    assert.equal(recordValue(toolResultAttempt.metadata).gateway_envelope_id, gatewayEnvelopeId);

    const entries = server.runtime.blackboardStore.query(sessionId, { keyPrefix: "symphony.operator.cancel" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, "decision");
    assert.deepEqual(entries[0].tags, ["gateway", "symphony", "operator", "cancel"]);
    assert.equal(recordValue(entries[0].value).gateway_envelope_id, gatewayEnvelopeId);
    const entryActionFact = recordValue(recordValue(entries[0].value).action_fact);
    assert.equal(entryActionFact.gateway_envelope_id, gatewayEnvelopeId);
    assert.equal(entryActionFact.attempt_id, operatorAttempt.attempt_id);
    assert.deepEqual((entryActionFact.replay as Array<{ status: string }>).map((step) => step.status), ["requested", "accepted", "applied"]);

    const gatewayEnvelope = server.runtime.traceStore.list(sessionId).find((envelope) => envelope.id === gatewayEnvelopeId);
    assert(gatewayEnvelope, "missing Gateway Symphony cancel envelope");
    assert.equal(gatewayEnvelope.from.agent_id, "gateway.local");
    assert.equal(gatewayEnvelope.type, "task.cancel");
    assert.equal(gatewayEnvelope.intent, "gateway.symphony.cancel");
    assert.equal(gatewayEnvelope.correlation_id, "corr-cancel-1");
    assert.equal(gatewayEnvelope.auth?.actor, "gateway.local.control");
    assert(gatewayEnvelope.auth?.scopes?.includes("gateway.symphony.cancel"));
    assert.equal(recordValue(gatewayEnvelope.payload).gateway_envelope_id, undefined);
    assert.equal(recordValue(gatewayEnvelope.payload).action_id, "action-cancel-1");
    const gatewayDeliveries = server.runtime.envelopeDeliveryStore.list({ sessionId, envelopeId: gatewayEnvelopeId });
    assert(gatewayDeliveries.some((delivery) =>
      delivery.status === "delivered" &&
      delivery.recipient_agent_id === "main_swarm"
    ));

    const status = await readJson<SymphonyStatusPayload>(`${started.url}/v1/symphony/status?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(recordValue(status.latest_action).action_id, "action-cancel-1");
    const statusSession = status.sessions.find((session) => session.session_id === sessionId);
    assert(statusSession, `missing status session: ${sessionId}`);
    assert.equal(recordValue(statusSession.latest_action).status, "applied");

    assert(streamSummary.events >= 2, `expected cancel stream events, got ${streamSummary.events}`);
    assert(streamSummary.lastEventId, "expected stream summary lastEventId");
    assert(streamSummary.replayWindow && streamSummary.replayWindow >= 1, "expected replay window metadata");
    assert(streamMessages.some((message) => typeof message.sequence === "number" && message.sequence > 0));
    const records = streamMessages.map((message) => message.data).filter(isWorkRecord);
    assert(records.every((record) => record.gateway_schema_version === "swarm.gateway.stream.v1"));
    assert(records.some((record) => record.kind === "session" && record.status === "cancelled"));
    assert(records.some((record) => record.kind === "task" && record.task_id === "symphony.operator.cancel" && record.action === "symphony.cancel"));
  } finally {
    if (streamTimeout) {
      clearTimeout(streamTimeout);
    }
    streamAbort.abort();
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony operator actions are idempotent by key", async () => {
  const fixture = createPreviewFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const preview = await postJson<PreviewResponse>(`${started.url}/v1/symphony/preview`, {
      workflow_path: fixture.workflowPath,
      create_workspace: false
    }, 201);
    const sessionId = stringValue(recordValue(preview.sessions[0].session).session_id, "preview session_id");
    const payload = {
      action: "cancel",
      session_id: sessionId,
      action_id: "action-idempotent-1",
      correlation_id: "corr-idempotent-1",
      idempotency_key: "gateway-action-once",
      reason: "operator smoke"
    };

    const first = await postJson<SymphonyActionResponse>(`${started.url}/v1/symphony/actions`, payload, 202);
    const second = await postJson<SymphonyActionResponse>(`${started.url}/v1/symphony/actions`, {
      ...payload,
      session_id: "missing-session",
      action_id: "action-idempotent-2",
      correlation_id: "corr-idempotent-2",
      reason: "operator smoke duplicate"
    }, 202);

    assert.equal(first.schema_version, "swarm.gateway.response.v1");
    assert.equal(second.schema_version, "swarm.gateway.response.v1");
    assert.equal(second.action_id, first.action_id);
    assert.equal(second.correlation_id, first.correlation_id);
    assert.equal(second.session_id, first.session_id);
    assert.deepEqual(recordValue(second.action_fact), recordValue(first.action_fact));

    const attempts = server.runtime.runAttemptStore.listByTask(sessionId, "symphony.operator.cancel")
      .filter((attempt) => attempt.runner_id === "gateway.symphony.operator");
    const entries = server.runtime.blackboardStore.query(sessionId, { keyPrefix: "symphony.operator.cancel.action-idempotent-1" });
    assert.equal(attempts.length, 1);
    assert.equal(entries.length, 1);
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony unsupported operator actions return recovery and persist attempts", async () => {
  const fixture = createPreviewFixture();
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    const preview = await postJson<PreviewResponse>(`${started.url}/v1/symphony/preview`, {
      workflow_path: fixture.workflowPath,
      create_workspace: false
    }, 201);
    const sessionId = stringValue(recordValue(preview.sessions[0].session).session_id, "preview session_id");

    const response = await fetch(`${started.url}/v1/symphony/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gatewayClientAuthHeaders()
      },
      body: JSON.stringify({
        action: "pause",
        session_id: sessionId,
        action_id: "action-pause-1",
        correlation_id: "corr-pause-1",
        reason: "operator smoke"
      })
    });
    const body = await response.json() as SymphonyActionResponse;

    assert.equal(body.action_id, "action-pause-1");
    assert.equal(body.correlation_id, "corr-pause-1");
    assert.equal(response.status, 501);
    assert.equal(body.action, "pause");
    assert.equal(body.status, "not_supported");
    assert.equal(body.session_id, sessionId);
    assert.equal(recordValue(body.action_fact).status, "not_supported");
    assert.match(body.recovery ?? "", /cancel/);
    assert.equal(recordValue(body.error).code, "SYMPHONY_ACTION_NOT_SUPPORTED");
    const gatewayEnvelopeId = stringValue(body.gateway_envelope_id, "pause.gateway_envelope_id");
    assert.equal(recordValue(body.action_fact).gateway_envelope_id, gatewayEnvelopeId);

    const attempts = server.runtime.runAttemptStore.listByTask(sessionId, "symphony.operator.pause");
    const operatorAttempt = attempts.find((attempt) => attempt.runner_id === "gateway.symphony.operator");
    const toolResultAttempt = attempts.find((attempt) => attempt.runner_id === "symphony.pause");
    assert(operatorAttempt, "missing Gateway operator pause attempt");
    assert(toolResultAttempt, "missing tool-result pause attempt");
    assert.equal(operatorAttempt.status, "failed");
    assert.equal(operatorAttempt.error_code, "SYMPHONY_ACTION_NOT_SUPPORTED");
    assert.match(operatorAttempt.recovery_suggestion ?? "", /status/);
    assert.equal(recordValue(recordValue(operatorAttempt.metadata).action_fact).status, "not_supported");
    assert.equal(recordValue(recordValue(operatorAttempt.metadata).action_fact).gateway_envelope_id, gatewayEnvelopeId);
    assert.equal(recordValue(operatorAttempt.metadata).gateway_envelope_id, gatewayEnvelopeId);
    assert.equal(recordValue(toolResultAttempt.metadata).gateway_envelope_id, gatewayEnvelopeId);

    const entries = server.runtime.blackboardStore.query(sessionId, { keyPrefix: "symphony.operator.pause" });
    assert.equal(entries.length, 1);
    assert.equal(recordValue(entries[0].value).gateway_envelope_id, gatewayEnvelopeId);
    assert.equal(recordValue(entries[0].value).status, "not_supported");
    assert.deepEqual((recordValue(recordValue(entries[0].value).action_fact).replay as Array<{ status: string }>).map((step) => step.status), ["requested", "not_supported"]);
    assert.equal(recordValue(recordValue(entries[0].value).action_fact).gateway_envelope_id, gatewayEnvelopeId);
    assert((entries[0].tags ?? []).includes("not_supported"));

    const gatewayEnvelope = server.runtime.traceStore.list(sessionId).find((envelope) => envelope.id === gatewayEnvelopeId);
    assert(gatewayEnvelope, "missing Gateway Symphony pause envelope");
    assert.equal(gatewayEnvelope.from.agent_id, "gateway.local");
    assert.equal(gatewayEnvelope.type, "task.progress");
    assert.equal(gatewayEnvelope.intent, "gateway.symphony.pause");
    assert.equal(gatewayEnvelope.correlation_id, "corr-pause-1");
    assert.equal(gatewayEnvelope.auth?.actor, "gateway.local.control");
    assert(gatewayEnvelope.auth?.scopes?.includes("gateway.symphony.pause"));
    assert.equal(recordValue(gatewayEnvelope.payload).action_id, "action-pause-1");
    const gatewayDeliveries = server.runtime.envelopeDeliveryStore.list({ sessionId, envelopeId: gatewayEnvelopeId });
    assert(gatewayDeliveries.some((delivery) =>
      delivery.status === "delivered" &&
      delivery.recipient_agent_id === "main_swarm"
    ));

    const status = await readJson<SymphonyStatusPayload>(`${started.url}/v1/symphony/status?workflow=${encodeURIComponent(fixture.workflowPath)}`);
    assert.equal(recordValue(status.latest_action).status, "not_supported");
  } finally {
    await server.stop();
    fixture.close();
  }
});

test("Gateway Symphony operator actions reject unknown targets and missing mutation auth", async () => {
  const fixture = createPreviewFixture();
  const oldToken = process.env.SWARM_GATEWAY_TOKEN;
  delete process.env.SWARM_GATEWAY_TOKEN;
  const server = new SwarmGatewayServer({
    host: "127.0.0.1",
    port: 0,
    workspace: fixture.root,
    databasePath: fixture.databasePath
  });
  try {
    const started = await server.start();
    await postJson<PreviewResponse>(`${started.url}/v1/symphony/preview`, {
      workflow_path: fixture.workflowPath,
      create_workspace: false
    }, 201);

    const missingSession = await fetch(`${started.url}/v1/symphony/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gatewayClientAuthHeaders()
      },
      body: JSON.stringify({
        action: "cancel",
        session_id: "missing-session"
      })
    });
    const missingSessionBody = await missingSession.json() as { error?: { status?: number; message?: string } };
    assert.equal(missingSession.status, 404);
    assert.match(missingSessionBody.error?.message ?? "", /Unknown Symphony session/);

    const missingItem = await fetch(`${started.url}/v1/symphony/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...gatewayClientAuthHeaders()
      },
      body: JSON.stringify({
        action: "cancel",
        work_item_key: "symphony:local:WK-999"
      })
    });
    const missingItemBody = await missingItem.json() as { error?: { status?: number; message?: string } };
    assert.equal(missingItem.status, 404);
    assert.match(missingItemBody.error?.message ?? "", /Unknown Symphony work item/);

    const denied = await fetch(`${started.url}/v1/symphony/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "cancel",
        session_id: "anything"
      })
    });
    const deniedBody = await denied.json() as { error?: { status?: number; message?: string } };
    assert.equal(denied.status, 403);
    assert.match(deniedBody.error?.message ?? "", /Gateway mutation requires/);
  } finally {
    await server.stop();
    fixture.close();
    if (oldToken === undefined) {
      delete process.env.SWARM_GATEWAY_TOKEN;
    } else {
      process.env.SWARM_GATEWAY_TOKEN = oldToken;
    }
  }
});

type JsonRecord = Record<string, unknown>;

type GatewayHealthPayload = {
  ok: boolean;
  routes: string[];
};

type SymphonyStatusPayload = {
  workflow: {
    ok: boolean;
    workflow: {
      path: string;
    };
  };
  scheduler: {
    running?: unknown[];
    capacity: {
      max_concurrent: number;
      running: number;
      available: number;
    };
  };
  totals: {
    sessions: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    retrying: number;
  };
  live_control: LiveControlPayload;
  work_board: WorkBoardPayload;
  latest_action?: unknown;
  sessions: Array<{
    session_id: string;
    latest_action?: unknown;
  }>;
};

type ApprovalQueuePayload = {
  summary: {
    actionable_pending: number;
    persisted_pending: number;
    approved: number;
    denied: number;
  };
};

type SessionSmokeViewPayload = {
  session_id: string;
  live_control: LiveControlPayload;
  approvals: ApprovalQueuePayload;
  work_board: WorkBoardPayload;
  work_snapshot: {
    session: {
      session_id: string;
      source?: WorkItem;
    };
  };
};

type LiveControlPayload = {
  status: string;
  severity: string;
  next_action?: string;
};

type WorkBoardPayload = {
  schema_version: "swarm.work_board.v1";
  summary: {
    sessions: number;
  };
  sessions: Array<{
    session_id: string;
  }>;
};

type GatewayWorkStreamRecord = WorkProtocolRecord & {
  gateway_schema_version?: string;
  sequence?: number;
  last_event_id?: number;
  replay_window?: number;
  missed_events_hint?: {
    requested_last_event_id?: number;
    oldest_replayable_event_id?: number;
    replay_window: number;
    missed: boolean;
  };
};

type McpResponse<T> = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
};

type McpToolsListResult = {
  tools: Array<{
    name: string;
  }>;
};

type McpToolCallResult = {
  content: Array<{
    type: string;
    text: string;
  }>;
  structuredContent?: unknown;
};

type PreviewResponse = {
  workflow: {
    path: string;
  };
  items: WorkItem[];
  sessions: Array<{
    session: Record<string, unknown>;
    workspace_path: string;
    prompt: string;
  }>;
};

type SymphonyActionResponse = {
  schema_version?: string;
  action_id?: string;
  correlation_id?: string;
  gateway_envelope_id?: string;
  action?: string;
  status?: string;
  session_id?: string;
  previous_status?: string;
  next_status?: string;
  work_item_key?: string;
  live_stop_requested?: boolean;
  attempt?: unknown;
  session?: unknown;
  action_fact?: unknown;
  error?: unknown;
  recovery?: string;
};

function createFixture(): { root: string; workflowPath: string; databasePath: string; close(): void } {
  const root = join(tmpdir(), `swarm-gateway-symphony-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspaceRoot = join(root, "workspaces");
  const workflowPath = join(root, "WORKFLOW.md");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(workflowPath, workflowText(workspaceRoot), "utf8");
  return {
    root,
    workflowPath,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function createPreviewFixture(): {
  root: string;
  workspaceRoot: string;
  workItemsPath: string;
  workflowPath: string;
  databasePath: string;
  close(): void;
} {
  const root = join(tmpdir(), `swarm-gateway-symphony-preview-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspaceRoot = join(root, "workspaces");
  const workItemsPath = join(root, "WORK_ITEMS.md");
  const workflowPath = join(root, "WORKFLOW.md");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(workItemsPath, previewWorkItemsText(), "utf8");
  writeFileSync(workflowPath, previewWorkflowText(workItemsPath, workspaceRoot), "utf8");
  return {
    root,
    workspaceRoot,
    workItemsPath,
    workflowPath,
    databasePath: join(root, "swarm.db"),
    close: () => {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

async function readJson<T = JsonRecord>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json() as JsonRecord;
  assert.equal(response.ok, true, JSON.stringify(body));
  return body as T;
}

async function postJson<T = JsonRecord>(url: string, body: Record<string, unknown>, expectedStatus = 200): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...gatewayClientAuthHeaders()
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as JsonRecord;
  assert.equal(response.status, expectedStatus, JSON.stringify(payload));
  return payload as T;
}

async function postMcp<T>(gatewayUrl: string, body: Record<string, unknown>): Promise<McpResponse<T>> {
  const response = await fetch(`${gatewayUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...gatewayClientAuthHeaders()
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as McpResponse<T>;
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.error, undefined, JSON.stringify(payload.error));
  return payload;
}

function assertPreviewEntry(
  entry: BlackboardEntry,
  expected: { workflowPath: string; workItem: WorkItem; workspacePath: string }
): void {
  assert.equal(entry.type, "plan");
  assert.equal(entry.key, "symphony.preview");
  assert.equal(entry.created_by.agent_id, "symphony");
  assert.deepEqual(entry.tags, ["symphony", "preview", "workflow"]);

  const value = recordValue(entry.value);
  assert.equal(stringValue(value.workflow_path, "blackboard.workflow_path"), expected.workflowPath);
  assert.deepEqual(value.work_item, expected.workItem);
  assert.equal(stringValue(value.workspace_path, "blackboard.workspace_path"), expected.workspacePath);
  assert.equal(stringValue(value.prompt, "blackboard.prompt"), previewPrompt(expected.workItem));
}

function previewObjective(item: WorkItem): string {
  return `${item.human_id}: ${item.title}`;
}

function previewPrompt(item: WorkItem): string {
  return `Preview ${item.human_id} | ${item.title} | state=${item.state} | source=${item.source_id}`;
}

function workflowText(workspaceRoot: string): string {
  return [
    "---",
    "work_source:",
    "  kind: fake",
    "  active_states: [Todo, In Progress]",
    "  terminal_states: [Done, Closed, Cancelled]",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "agent:",
    "  max_concurrent_agents: 2",
    "---",
    "Implement {{issue.identifier}}: {{issue.title}}"
  ].join("\n");
}

function previewWorkItemsText(): string {
  return [
    "# Local work",
    "- [ ] WK-101: Normalize active preview item",
    "- [ ] WK-102: Persist preview metadata",
    "- [x] WK-103: Terminal item must not preview"
  ].join("\n");
}

function previewWorkflowText(workItemsPath: string, workspaceRoot: string): string {
  return [
    "---",
    "work_source:",
    "  kind: local",
    `  path: \"${workItemsPath.replace(/\\/g, "/")}\"`,
    "  active_states: [Todo]",
    "  terminal_states: [Done]",
    "workspace:",
    `  root: \"${workspaceRoot.replace(/\\/g, "/")}\"`,
    "agent:",
    "  max_concurrent_agents: 2",
    "---",
    "Preview {{ issue.identifier }} | {{ issue.title }} | state={{ issue.state }} | source={{ issue.source_id }}"
  ].join("\n");
}

function recordValue(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "expected record value");
  return value as Record<string, unknown>;
}

function isWorkRecord(value: unknown): value is GatewayWorkStreamRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { kind?: unknown }).kind === "string");
}

function stringValue(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing ${description}`);
  }
  return value;
}

function parseJson<T>(value: string | null | undefined, description: string): T {
  assert(value, `missing ${description}`);
  return JSON.parse(value) as T;
}
