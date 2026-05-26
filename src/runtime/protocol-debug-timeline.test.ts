import { strict as assert } from "node:assert";
import test from "node:test";
import type { RuntimeEvent } from "./events.js";
import {
  buildProtocolDebugTimeline,
  filterProtocolTimeline,
  formatProtocolDebugTimeline,
  redactTimelineValue
} from "./protocol-debug-timeline.js";

const AT = "2026-05-25T00:00:00.000Z";

test("protocol timeline groups envelope ownership and blackboard events by correlation", () => {
  const summary = buildProtocolDebugTimeline({
    capturedEvents: [
      {
        at: AT,
        event: {
          type: "envelope",
          envelope: {
            id: "env-assign-1",
            version: "1.0",
            swarm_id: "swarm-1",
            session_id: "session-1",
            task_id: "task-1",
            from: { agent_id: "router" },
            to: { agent_id: "worker-1" },
            type: "task.assign",
            intent: "assign task",
            correlation_id: "corr-1",
            created_at: AT,
            payload: { owner_agent_id: "worker-1", assignment_envelope_id: "env-assign-1" }
          }
        }
      },
      {
        at: "2026-05-25T00:00:01.000Z",
        event: {
          type: "blackboard",
          entry: {
            entry_id: "bb-1",
            swarm_id: "swarm-1",
            session_id: "session-1",
            task_id: "task-1",
            key: "decision/task-1",
            value: { verdict: "accepted" },
            type: "decision",
            created_by: { agent_id: "worker-1" },
            created_at: "2026-05-25T00:00:01.000Z",
            visibility: "team",
            version: 1,
            metadata: {
              kind: "decision",
              source_envelope_id: "env-assign-1",
              correlation_id: "corr-1"
            }
          }
        }
      }
    ]
  });

  const group = summary.correlations.find((candidate) => candidate.correlation_id === "corr-1");
  assert(group);
  assert.equal(group.events, 3);
  assert.deepEqual(group.categories.sort(), ["blackboard", "envelope", "ownership"]);
  assert.deepEqual(group.actors.sort(), ["router", "worker-1"]);
  assert.deepEqual(group.tasks, ["task-1"]);
  assert.equal(summary.by_category.envelope, 1);
  assert.equal(summary.by_category.ownership, 1);
  assert.equal(summary.by_category.blackboard, 1);
});

test("protocol timeline redacts secrets and omits raw blackboard values", () => {
  const summary = buildProtocolDebugTimeline({
    capturedEvents: [
      {
        at: AT,
        event: {
          type: "blackboard",
          entry: {
            entry_id: "bb-secret",
            swarm_id: "swarm-1",
            session_id: "session-1",
            task_id: "task-secret",
            key: "prompt-cache/sk-secret1234567890",
            value: {
              raw_prompt: "Authorization: Bearer abcdefghijklmnop",
              apiKey: "sk-test1234567890"
            },
            type: "evidence",
            created_by: { agent_id: "worker-secret" },
            created_at: AT,
            visibility: "team",
            version: 1,
            metadata: {
              kind: "write",
              correlation_id: "corr-secret",
              source_envelope_id: "env-secret",
              token: "secret-token-1234567890"
            }
          }
        }
      }
    ]
  });

  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /sk-secret1234567890/);
  assert.doesNotMatch(serialized, /sk-test1234567890/);
  assert.doesNotMatch(serialized, /Bearer abcdefghijklmnop/);
  assert.doesNotMatch(serialized, /raw_prompt/);
  assert.match(serialized, /REDACTED|sk-REDACTED|Bearer REDACTED/);
  assert.equal(redactTimelineValue({ apiKey: "sk-test1234567890" }) instanceof Object, true);
});

test("protocol timeline filters by actor task correlation category and text", () => {
  const events: RuntimeEvent[] = [
    {
      type: "envelope",
      envelope: {
        id: "env-a",
        version: "1.0",
        swarm_id: "swarm-1",
        session_id: "session-1",
        task_id: "task-a",
        from: { agent_id: "worker-a" },
        to: { agent_id: "router" },
        type: "task.result",
        intent: "return result",
        correlation_id: "corr-a",
        created_at: AT,
        payload: { owner_agent_id: "worker-a" }
      }
    },
    {
      type: "provider_usage",
      usage: {
        providerId: "deepseek",
        protocol: "openai-chat-completions",
        model: "deepseek-v4-flash",
        purpose: "worker-b",
        sessionId: "session-1",
        taskId: "task-b",
        cacheMode: "prefix-structured",
        promptCacheKey: "swarm:test",
        promptCacheScope: "scope",
        cacheablePrefixTokensEstimate: 1024,
        durationMs: 12,
        cachedInputTokens: 0,
        totalInputWithCacheTokens: 2048,
        cacheHitRate: 0,
        promptCacheDiagnostics: {
          scope: "scope",
          status: "cache_miss",
          changed: ["requestPrefixHash4096"],
          changedSections: ["tools"],
          missReason: "changed_tools",
          current: {
            systemHash: "system",
            userHash: "user",
            cacheablePrefixHash: "prefix",
            cacheableSystemHash: "system-prefix",
            cacheableUserHash: "user-prefix",
            toolSchemaHash: "tools",
            dynamicUserHash: "dynamic",
            requestPrefixHash1024: "1024",
            requestPrefixHash4096: "4096",
            firstDynamicBlockIndex: 1,
            cacheKey: "swarm:test",
            model: "deepseek-v4-flash",
            protocol: "openai-chat-completions",
            retention: "in_memory",
            ttlSeconds: 3600,
            anthropicTtl: "5m"
          },
          minimumCacheableTokens: 1024
        }
      }
    }
  ];
  const summary = buildProtocolDebugTimeline({
    capturedEvents: events.map((event, index) => ({ at: new Date(index).toISOString(), event }))
  });

  assert.equal(filterProtocolTimeline(summary.events, { actorId: "worker-a" }).length, 2);
  assert.equal(filterProtocolTimeline(summary.events, { taskId: "task-b" }).length, 1);
  assert.equal(filterProtocolTimeline(summary.events, { correlationId: "corr-a" }).length, 2);
  assert.equal(filterProtocolTimeline(summary.events, { category: "cache" }).length, 1);
  assert.match(formatProtocolDebugTimeline({ events: summary.events, filter: { text: "cache_miss" } }), /cache_miss/);
});

test("protocol timeline filters source adapter envelopes by source", () => {
  const summary = buildProtocolDebugTimeline({
    capturedEvents: [{
      at: AT,
      event: {
        type: "envelope",
        envelope: {
          id: "env-source-gateway",
          version: "1.0",
          swarm_id: "swarm-1",
          session_id: "session-1",
          from: { agent_id: "gateway.local", role: "source_adapter" },
          to: { agent_id: "main_swarm" },
          type: "user.message",
          intent: "source.user.message",
          correlation_id: "gateway-req-1",
          created_at: AT,
          payload: {
            source: "gateway",
            source_id: "http",
            trust_level: "trusted",
            content: "hello"
          }
        }
      }
    }]
  });

  assert.equal(filterProtocolTimeline(summary.events, { source: "gateway" }).length, 1);
  assert.equal(filterProtocolTimeline(summary.events, { source: "cli" }).length, 0);
  assert.equal(summary.events[0]?.source, "gateway");
});
