import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import React from "react";
import { renderTuiToFrame } from "../renderer/testing.js";
import { assertFrameHasNoOverflow, createFrameSnapshot } from "../renderer/frame-snapshot.js";
import { displayWidth } from "../display-width.js";
import { NeedsYouStrip } from "../components/NeedsYouStrip.js";
import { TicketsPane } from "../components/TicketsPane.js";
import { ConversationHeader } from "../components/ConversationHeader.js";
import { truncateSpans } from "../components/SemanticTextLine.js";
import { needsYouItems, needsYouRows, paneOrder, ticketDetailText, ticketsFooterValue, ticketsPaneLines, ticketsPillValue } from "./view-model.js";
import { runTicketCommand } from "./commands.js";
import { TuiTickets } from "./controller.js";
import type { TicketRow } from "../../superagent/views.js";
import { KV } from "../../superagent/kv.js";
import { savePeer } from "../../mesh/state.js";

const row = (overrides: Partial<TicketRow>): TicketRow => ({
  id: "a1b2c3d4e5f6a7b8", short: "a1b2c3d4", title: "Fix the flaky retry test", group: "working", label: "Working", source: "github",
  updatedAt: "2026-11-01T00:00:00.000Z", ...overrides
});
const rows: TicketRow[] = [
  row({ id: "1".repeat(32), short: "11111111", group: "working", label: "Working", title: "Add retry jitter" }),
  row({ id: "2".repeat(32), short: "22222222", group: "person", label: "Awaiting answer", title: "Config precedence", question: "Should SWARM_MODEL win?" }),
  row({ id: "3".repeat(32), short: "33333333", group: "person", label: "Awaiting review", title: "Shorten the save label", pr: 31 }),
  row({ id: "4".repeat(32), short: "44444444", group: "person", label: "Failed", title: "Rename the build script" }),
  row({ id: "5".repeat(32), short: "55555555", group: "ended", label: "Completed", title: "Fix the README typo" })
];
const plain = (frame: ReturnType<typeof renderTuiToFrame>) => frame.screen.cells.map((cells) => cells.map((cell) => cell.char).join("").trimEnd()).join("\n");

test("needs-you items say what each ticket needs and the command that answers it", () => {
  const items = needsYouItems(rows);
  assert.deepEqual(items.map((item) => [item.marker, item.need, item.action]), [
    ["?", "asks: Should SWARM_MODEL win?", "/ticket say 22222222 <answer>"],
    ["!", "awaiting review · PR #31", "/ticket 33333333"],
    ["×", "failed", "/ticket retry 44444444"]
  ]);
  assert.equal(needsYouRows(items), 4);
  assert.equal(needsYouRows(items, 2), 4, "a heading, two items and +1 more");
  assert.equal(needsYouRows([]), 0);
});

test("the footer and pane summaries put what needs a person first", () => {
  const status = { running: true, counts: { person: 3, working: 1, queued: 0, idle: 0, ended: 1 } };
  assert.equal(ticketsFooterValue(status), "3 need you");
  assert.equal(ticketsPillValue(status), "3 need you · 1 working");
  assert.equal(ticketsFooterValue({ running: false, counts: { person: 0, working: 0, queued: 0, idle: 0, ended: 0 } }), "no host");
});

test("the tickets pane groups tickets by what they wait for and indexes the selection in that order", () => {
  const ordered = paneOrder(rows);
  assert.deepEqual(ordered.map((item) => item.short), ["22222222", "33333333", "44444444", "11111111", "55555555"]);
  const lines = ticketsPaneLines(rows, 3);
  assert.deepEqual(lines.filter((line) => line.kind === "group").map((line) => line.kind === "group" ? line.text : ""), ["Needs you (3)", "Working (1)", "Ended (1)"]);
  const selected = lines.find((line) => line.kind === "ticket" && line.selected);
  assert.equal(selected?.kind === "ticket" ? selected.row.short : "", "11111111");
  assert.match(ticketDetailText(rows[1]!, [{ kind: "acknowledgement", text: "On it." }]), /Answer with: \/ticket say 22222222/);
});

test("truncateSpans keeps a multi-span line within its width, also with wide characters", () => {
  const spans = [{ text: "? " }, { text: "修复调度器里不稳定的重试测试" }, { text: "  asks: 哪个配置优先？" }, { text: "  /ticket say 22222222" }];
  for (const width of [10, 24, 40, 200]) {
    const cut = truncateSpans(spans, width);
    assert.ok(displayWidth(cut.map((span) => span.text).join("")) <= width, `fits ${width}`);
  }
  assert.equal(truncateSpans(spans, 200).length, spans.length);
});

test("the needs-you strip fits narrow terminals and keeps each item's command visible", () => {
  const items = needsYouItems([...rows, row({ id: "6".repeat(32), short: "66666666", group: "person", label: "Blocked", title: "这是一个很长的中文工单标题，用来测试宽字符截断是否正确" })]);
  for (const columns of [80, 120]) {
    const frame = renderTuiToFrame(React.createElement(NeedsYouStrip, { items, columns }), { columns, rows: 6 });
    assertFrameHasNoOverflow(createFrameSnapshot(frame));
    const text = plain(frame);
    assert.match(text, /needs you/);
    assert.match(text, /\/ticket say 22222222/);
    assert.match(text, /\+1 more/);
  }
});

test("the tickets pane and header render within the terminal", () => {
  const pane = renderTuiToFrame(React.createElement(TicketsPane, { rows: paneOrder(rows), selected: 0, columns: 80, height: 12, summary: "3 need you · 1 working", hosting: true }), { columns: 80, rows: 12 });
  assertFrameHasNoOverflow(createFrameSnapshot(pane));
  assert.match(plain(pane), /▸ \? 22222222/);
  assert.match(plain(pane), /host in this TUI/);
  const header = renderTuiToFrame(React.createElement(ConversationHeader, { columns: 60, model: "kimi-coding/kimi-for-coding",
    workspace: "~/Playground/a-very-long-project-directory-name/that-keeps-going", right: [{ text: "work · ask · rw" }] }), { columns: 60, rows: 1 });
  assertFrameHasNoOverflow(createFrameSnapshot(header));
  assert.match(plain(header), /^ Swarm · kimi-coding/);
  assert.match(plain(header), /work · ask · rw$/);
});

test("ticket commands file a request, show and answer a ticket, and do not start a host while another runs", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "swarm-tui-tickets-"));
  // Another host holds the lock: this process.
  writeFileSync(join(stateDir, "host.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const tickets = new TuiTickets({ stateDir, log: () => {} });
  try {
    assert.equal(tickets.available(), false);
    const filed = await runTicketCommand(tickets, "ticket", ["rename", "the", "build", "script"]);
    assert.match(filed.brief, /Filed as a ticket request/);
    assert.doesNotMatch(filed.brief, /Started the ticket host/);
    assert.equal(tickets.available(), true);
    const snapshot = await tickets.snapshot();
    assert.equal(snapshot?.rows.length, 0, "no ticket until the host routes the request");

    const { SuperagentClient } = await import("../../superagent/client.js");
    const client = new SuperagentClient({ stateDir });
    const { triggerId } = client.request("decide which config key wins");
    client.engine.evaluateDue();
    const candidate = client.engine.candidate(triggerId)!;
    const { ticketId } = client.engine.decide(triggerId, { kind: "accept", title: "Config precedence", scope: "x", reason: "asked", name: "config-precedence", evalId: candidate.evalId });
    client.engine.assignmentStarted(ticketId!, client.store.tickets.get(ticketId!)!.assignments[0]!.id);
    client.engine.report(ticketId!, { state: "progress", summary: "Two keys", question: "Which key wins?" });
    client.close();

    const handle = ticketId!.slice(0, 8);
    const shown = await runTicketCommand(tickets, "ticket", [handle]);
    assert.match(shown.brief, /Awaiting answer · Config precedence/);
    assert.match(shown.detail ?? "", /Question: Which key wins\?/);
    const answered = await runTicketCommand(tickets, "ticket", ["say", handle, "settings", "win"]);
    assert.match(answered.brief, /Sent to ticket/);
    const pane = await runTicketCommand(tickets, "tickets", []);
    assert.equal(pane.openPane, true);
    await assert.rejects(runTicketCommand(tickets, "ticket", ["stop"]), /Usage/);
  } finally {
    await tickets.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("/ticket --on files a request here whose worker runs on a paired node, and says when no mesh node runs to place it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "swarm-tui-tickets-"));
  const meshHome = mkdtempSync(join(tmpdir(), "swarm-tui-mesh-"));
  savePeer({ id: "gpu-node", name: "gpu", url: "http://127.0.0.1:9", token: "a-token-gpu-issued-us", tokenHash: "0".repeat(64), pairedAt: new Date().toISOString() }, meshHome);
  const tickets = new TuiTickets({ stateDir, meshHome, log: () => {} });
  try {
    const filed = await runTicketCommand(tickets, "ticket", ["--on", "gpu", "retrain", "the", "model"]);
    assert.match(filed.brief, /its worker runs on gpu/);
    assert.match(filed.brief, /swarm node run/, "no mesh node's host runs here to place it");
    const { SuperagentClient } = await import("../../superagent/client.js");
    const client = new SuperagentClient({ stateDir });
    const [placement] = client.store.keys(KV.mesh.placement).map((key) => client.store.get(key));
    client.close();
    assert.deepEqual(placement?.on, { id: "gpu-node", name: "gpu" });
    await assert.rejects(runTicketCommand(tickets, "ticket", ["--on", "nowhere", "retrain"]), /No paired device "nowhere"/);
    await assert.rejects(runTicketCommand(tickets, "ticket", ["--on", "gpu"]), /Usage: \/ticket --on/);
  } finally {
    await tickets.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(meshHome, { recursive: true, force: true });
  }
});
