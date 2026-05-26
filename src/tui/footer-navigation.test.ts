import { strict as assert } from "node:assert";
import test from "node:test";
import type { BudgetGovernorReport } from "../runtime/budget-governor.js";
import {
  buildFooterPills,
  createFooterNavigationState,
  footerNavigationReducer,
  footerRowBudget,
  selectedFooterPill
} from "./footer-navigation.js";
import {
  budgetPressureSurface,
  defaultVisibleServiceNotices,
  formatServiceStatusSection,
  serviceClusterItem,
  serviceNotice,
  serviceNoticeSeverity
} from "./status-surface.js";

test("footer navigation cycles compact service pills and opens the selected target", () => {
  const items = buildFooterPills({
    taskCompleted: 1,
    taskTotal: 3,
    pendingApprovals: 2,
    cacheStatus: "cache_miss",
    cacheHitRate: 0,
    gatewayStatus: "local",
    symphonyRunning: 1,
    symphonyRetrying: 0,
    lspStatus: "ready"
  });
  let state = createFooterNavigationState();

  assert.deepEqual(items.filter((item) => ["cache", "gateway", "symphony", "lsp"].includes(item.id)).map((item) => [item.id, item.value, item.tone]), [
    ["cache", "MISS 0%", "muted"],
    ["gateway", "LOCAL", "success"],
    ["symphony", "1 run", "running"],
    ["lsp", "READY", "success"]
  ]);
  assert.equal(selectedFooterPill(state, items), undefined);
  assert.deepEqual(footerNavigationReducer(state, { type: "open" }, items), state);

  state = footerNavigationReducer(state, { type: "next" }, items);
  assert.equal(selectedFooterPill(state, items)?.id, "tasks");

  state = footerNavigationReducer(state, { type: "next" }, items);
  assert.equal(selectedFooterPill(state, items)?.id, "approvals");

  state = footerNavigationReducer(state, { type: "previous" }, items);
  assert.equal(selectedFooterPill(state, items)?.id, "tasks");

  state = footerNavigationReducer(state, { type: "open" }, items);
  assert.equal(state.openId, "tasks");

  state = footerNavigationReducer(state, { type: "open", id: "cache" }, items);
  assert.equal(state.openId, "cache");
  assert.equal(state.selectedId, "cache");
});

test("footer row budget reserves one prompt footer row and bounded panel rows", () => {
  const items = buildFooterPills({
    taskCompleted: 0,
    taskTotal: 0,
    pendingApprovals: 0,
    symphonyRunning: 0,
    symphonyRetrying: 0
  });

  assert.deepEqual(footerRowBudget({ footerItems: items, terminalRows: 24 }), {
    footerRows: 1,
    panelRows: 0
  });
  assert.deepEqual(footerRowBudget({ footerItems: items, terminalRows: 24, panelOpen: true }), {
    footerRows: 1,
    panelRows: 6
  });
});

test("service status rules hide healthy noise but surface degraded and failed states", () => {
  assert.equal(serviceNoticeSeverity("ready"), "hidden");
  assert.equal(serviceNoticeSeverity("cache_miss"), "info");
  assert.equal(serviceNoticeSeverity("reconnecting"), "warning");
  assert.equal(serviceNoticeSeverity("failed"), "error");

  const visible = defaultVisibleServiceNotices([
    serviceNotice({ service: "cache", status: "cache_hit" }),
    serviceNotice({ service: "gateway", status: "reconnecting" }),
    serviceNotice({ service: "lsp", status: "unavailable" }),
    serviceNotice({ service: "symphony", status: "failed" })
  ]);

  assert.deepEqual(visible.map((notice) => notice.service), ["gateway", "lsp", "symphony"]);
  assert.match(formatServiceStatusSection({ gatewayStatus: "local", symphonyStatus: "failed", lspStatus: "ready" }), /gateway=local value=LOCAL tone=success severity=hidden/);
  assert.match(formatServiceStatusSection({ gatewayStatus: "local", symphonyStatus: "failed", lspStatus: "ready" }), /symphony=failed value=FAILED tone=danger severity=error/);
});

test("service cluster item keeps unknown services muted until actionable", () => {
  assert.deepEqual(serviceClusterItem({ service: "lsp", status: "unknown" }), {
    service: "lsp",
    label: "lsp",
    value: "NO PROVIDER",
    evidence: "NO PROVIDER",
    status: "unknown",
    tone: "muted",
    severity: "info",
    summary: "lsp: unknown",
    defaultVisible: false,
    nextAction: undefined
  });
  assert.equal(serviceClusterItem({ service: "gateway", status: "unavailable" }).tone, "warning");
  assert.equal(serviceClusterItem({ service: "symphony", running: 2, retrying: 1, status: "retrying" }).value, "2 run/1 retry");
  assert.equal(serviceClusterItem({ service: "cache", status: "cache_hit", hitRate: 0.74 }).value, "HIT 74%");
});

test("service cluster values expose readable evidence for cache gateway lsp and symphony", () => {
  assert.deepEqual(serviceClusterItem({ service: "cache", status: "cache_hit", hitRate: 0.74 }).evidence, "HIT 74%");
  assert.deepEqual(serviceClusterItem({ service: "cache", status: "cache_miss", hitRate: 0 }).evidence, "MISS 0%");
  assert.deepEqual(serviceClusterItem({ service: "gateway", status: "local" }).evidence, "LOCAL");
  assert.deepEqual(serviceClusterItem({ service: "gateway", status: "external" }).evidence, "REMOTE");
  assert.deepEqual(serviceClusterItem({ service: "lsp", status: "unknown" }).evidence, "NO PROVIDER");
  assert.deepEqual(serviceClusterItem({ service: "lsp", status: "typescript_semantic_fallback" }).evidence, "TS FALLBACK");
  assert.deepEqual(serviceClusterItem({ service: "symphony", running: 0, retrying: 0, status: "unknown" }).evidence, "NO DAEMON");
});

test("service status section surfaces budget pressure and sleeping actors", () => {
  const budget = {
    schema_version: "swarm.budget_governor.v1",
    generated_at: "2026-05-26T00:00:00.000Z",
    status: "exhausted",
    decisions: [],
    metrics: {
      tokens_used: 10_000,
      tokens_limit: 10_000,
      cost_used: 9.5,
      cost_limit: 10,
      running: 4,
      concurrency_limit: 4,
      queue_depth: 12,
      queue_limit: 10,
      provider_retry_count: 2,
      max_provider_retries: 3,
      deferred_tasks: 2,
      sleeping_actors: 1,
      accepted_tasks_preserved: 1
    }
  } satisfies BudgetGovernorReport;
  const section = formatServiceStatusSection({ budget });
  const surface = budgetPressureSurface(budget);

  assert.equal(surface.summary, "budget exhausted deferred=2 sleeping=1 preserved=1");
  assert.match(section, /swarm=exhausted value=exhausted d2\/s1 tone=warning severity=warning/);
  assert.match(section, /next=Wait for retry-after, reduce concurrency, or resume deferred low-priority work later\./);
});
