import { strict as assert } from "node:assert";
import test from "node:test";
import { createEnvelope } from "../protocol/envelope.js";
import type { EnvelopeDeliveryRecord } from "../storage/envelope-delivery-store.js";
import {
  budgetDecisionForDelivery,
  budgetDecisionToEnvelope,
  formatBudgetPressure,
  SwarmBudgetGovernor
} from "./budget-governor.js";

test("budget governor pauses low priority actors", () => {
  const governor = new SwarmBudgetGovernor({
    now: "2026-05-26T00:00:00.000Z",
    session: {
      queue_depth: 10,
      max_queue_depth: 10,
      running: 4,
      max_concurrency: 4
    }
  });

  const decision = governor.decide({
    actor_id: "worker:low",
    session_id: "session-budget",
    task_id: "task-low",
    priority: "low"
  });

  assert.equal(decision.action, "defer");
  assert.equal(decision.pressure, "exhausted");
  assert.equal(decision.preserve_ownership, false);
  assert.equal(decision.metrics.deferred_tasks, 1);
  assert.match(decision.reason, /low priority|budget exhausted/i);
});

test("provider retry after applies mailbox backpressure", () => {
  const governor = new SwarmBudgetGovernor({
    now: "2026-05-26T00:00:00.000Z",
    accepted_task_ids: ["task-accepted"],
    provider: {
      openai: {
        retry_after_ms: 30_000,
        provider_retry_count: 1,
        max_provider_retries: 3
      }
    }
  });

  const decision = governor.decide({
    actor_id: "worker:accepted",
    session_id: "session-budget",
    task_id: "task-accepted",
    provider_id: "openai",
    priority: "normal",
    envelope_id: "env-budget"
  });
  const envelope = budgetDecisionToEnvelope(decision);

  assert.equal(decision.action, "sleep");
  assert.equal(decision.pressure, "critical");
  assert.equal(decision.scope, "provider");
  assert.equal(decision.preserve_ownership, true);
  assert.equal(decision.metrics.sleeping_actors, 1);
  assert.equal(decision.metrics.accepted_tasks_preserved, 1);
  assert.equal(decision.retry_after_ms, 30_000);
  assert.equal(decision.sleep_until, "2026-05-26T00:00:30.000Z");
  assert.equal(envelope.intent, "budget.sleep");
  assert.equal(envelope.reply_to, "env-budget");
});

test("budget report includes cost retry and backpressure metrics", () => {
  const governor = new SwarmBudgetGovernor({
    now: "2026-05-26T00:00:00.000Z",
    accepted_task_ids: ["task-accepted"],
    session: {
      used_tokens: 9_500,
      max_tokens: 10_000,
      used_cost: 9,
      max_cost: 10,
      queue_depth: 8,
      max_queue_depth: 10
    },
    provider: {
      openai: {
        provider_retry_count: 2,
        max_provider_retries: 3
      }
    }
  });
  const decisions = [
    governor.decide({
      actor_id: "worker:normal",
      session_id: "session-budget",
      task_id: "task-normal",
      provider_id: "openai",
      priority: "normal"
    }),
    governor.decide({
      actor_id: "worker:low",
      session_id: "session-budget",
      task_id: "task-low",
      provider_id: "openai",
      priority: "low"
    }),
    governor.decide({
      actor_id: "worker:accepted",
      session_id: "session-budget",
      task_id: "task-accepted",
      provider_id: "openai",
      priority: "high"
    })
  ];
  const report = governor.report(decisions, { generatedAt: "2026-05-26T00:00:01.000Z" });
  const formatted = formatBudgetPressure(report).join("\n");

  assert.equal(report.schema_version, "swarm.budget_governor.v1");
  assert.equal(report.status, "critical");
  assert.equal(report.metrics.tokens_used, 9_500);
  assert.equal(report.metrics.cost_used, 9);
  assert.equal(report.metrics.provider_retry_count, 2);
  assert.equal(report.metrics.deferred_tasks, 1);
  assert.equal(report.metrics.sleeping_actors, 1);
  assert.equal(report.metrics.accepted_tasks_preserved, 1);
  assert.match(formatted, /budget status=critical/);
  assert.match(formatted, /deferred=1/);
  assert.match(formatted, /sleeping=1/);
  assert.match(formatted, /retries=2\/3/);
});

test("budget decision reads provider and cost metadata from envelope payload", () => {
  const governor = new SwarmBudgetGovernor({
    provider: {
      openai: {
        retry_after_ms: 10_000
      }
    }
  });
  const envelope = createEnvelope({
    swarm_id: "swarm-budget",
    session_id: "session-budget",
    task_id: "task-budget",
    from: { agent_id: "main_swarm" },
    to: { agent_id: "worker:budget" },
    type: "task.assign",
    intent: "assign with provider budget",
    payload: {
      provider_id: "openai",
      estimated_tokens: 1200,
      estimated_cost: 0.02
    }
  });
  const decision = budgetDecisionForDelivery(governor, "worker:budget", envelope, {
    delivery_id: "delivery-budget",
    envelope_id: envelope.id,
    session_id: envelope.session_id,
    swarm_id: envelope.swarm_id,
    task_id: envelope.task_id,
    type: envelope.type,
    intent: envelope.intent,
    recipient_key: "agent:worker:budget",
    recipient_agent_id: "worker:budget",
    status: "queued",
    queued_at: "2026-05-26T00:00:00.000Z",
    metadata: {}
  } satisfies EnvelopeDeliveryRecord);

  assert.equal(envelope.payload.provider_id, "openai");
  assert.equal(envelope.payload.estimated_tokens, 1200);
  assert.equal(decision?.provider_id, "openai");
  assert.equal(decision?.action, "defer");
  assert.equal(decision?.retry_after_ms, 10_000);
});
