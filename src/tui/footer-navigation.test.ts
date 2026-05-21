import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildFooterPills,
  createFooterNavigationState,
  footerNavigationReducer,
  footerRowBudget,
  selectedFooterPill
} from "./footer-navigation.js";
import {
  defaultVisibleServiceNotices,
  formatServiceStatusSection,
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
  assert.match(formatServiceStatusSection({ gatewayStatus: "local", symphonyStatus: "failed", lspStatus: "ready" }), /symphony=failed severity=error/);
});
