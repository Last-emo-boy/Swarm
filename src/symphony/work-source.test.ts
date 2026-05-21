import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkItem } from "../protocol/types.js";
import type { WorkflowRuntimeConfig } from "./workflow.js";
import {
  createWorkSourceFromConfig,
  FakeWorkSource,
  LocalWorkSource,
  normalizeRecordToWorkItem,
  workSourceIdentity
} from "./work-source.js";

test("local markdown source parses checkbox work items and keeps source files read-only", async () => {
  const fixture = createFixture();
  try {
    const sourcePath = join(fixture.root, "WORK_ITEMS.md");
    const markdown = [
      "# Work items",
      "- [ ] WK-101: Parse markdown source",
      "- [x] WK-102: Preserve closed source",
      "- [ ] Free-form item without identifier"
    ].join("\n");
    writeFileSync(sourcePath, markdown, "utf8");

    const source = new LocalWorkSource(sourcePath);
    const candidates = await source.fetchCandidateItems();
    const terminal = await source.listTerminalItems();
    const afterRead = readFileSync(sourcePath, "utf8");

    assert.deepEqual(candidates.map((item) => item.human_id), ["WK-101", "LOCAL-3"]);
    assert.deepEqual(candidates.map((item) => item.title), [
      "Parse markdown source",
      "Free-form item without identifier"
    ]);
    assert.equal(candidates[0].source, "symphony");
    assert.equal(candidates[0].source_id?.endsWith(":WK-101"), true);
    assert.deepEqual(candidates[0].labels, ["local"]);
    assert.equal(candidates[0].metadata.work_source_kind, "local");
    assert.equal(candidates[0].metadata.local_path, sourcePath);
    assert.equal(candidates[0].metadata.line_index, 1);

    assert.deepEqual(terminal.map((item) => item.human_id), ["WK-102"]);
    assert.equal(terminal[0].state, "Done");
    assert.equal(afterRead, markdown);
  } finally {
    fixture.close();
  }
});

test("local JSON and JSONL sources normalize records and split active from terminal states", async () => {
  const fixture = createFixture();
  try {
    const jsonPath = join(fixture.root, "WORK_ITEMS.json");
    writeFileSync(jsonPath, JSON.stringify({
      items: [
        {
          id: "json-1",
          identifier: "JSON-1",
          title: "JSON active",
          description: "from object wrapper",
          priority: 2,
          state: "In Progress",
          labels: ["Local", "Backend"],
          metadata: { source_note: "json" }
        },
        {
          id: "json-2",
          identifier: "JSON-2",
          title: "JSON terminal",
          state: "Closed",
          labels: ["Done"]
        },
        {
          id: "ignored",
          state: "Todo"
        }
      ]
    }), "utf8");

    const jsonSource = new LocalWorkSource(jsonPath);
    const jsonCandidates = await jsonSource.fetchCandidateItems();
    const jsonTerminal = await jsonSource.listTerminalItems();

    assert.deepEqual(jsonCandidates.map((item) => item.human_id), ["JSON-1"]);
    assert.equal(jsonCandidates[0].description, "from object wrapper");
    assert.equal(jsonCandidates[0].priority, 2);
    assert.deepEqual(jsonCandidates[0].labels, ["local", "backend"]);
    assert.equal(jsonCandidates[0].metadata.work_source_kind, "local");
    assert.equal(jsonCandidates[0].metadata.source_note, "json");
    assert.deepEqual(jsonTerminal.map((item) => item.human_id), ["JSON-2"]);

    const jsonlPath = join(fixture.root, "WORK_ITEMS.jsonl");
    writeFileSync(jsonlPath, [
      JSON.stringify({ id: "jsonl-1", human_id: "JSONL-1", title: "JSONL active", state: "Todo" }),
      JSON.stringify({ id: "jsonl-2", identifier: "JSONL-2", title: "JSONL terminal", state: "Done" }),
      JSON.stringify(["not", "a", "record"])
    ].join("\n"), "utf8");

    const jsonlSource = new LocalWorkSource(jsonlPath);
    const jsonlCandidates = await jsonlSource.fetchCandidateItems();
    const jsonlTerminal = await jsonlSource.listTerminalItems();

    assert.deepEqual(jsonlCandidates.map((item) => item.human_id), ["JSONL-1"]);
    assert.equal(jsonlCandidates[0].source_id, "jsonl-1");
    assert.deepEqual(jsonlCandidates[0].labels, ["local"]);
    assert.deepEqual(jsonlTerminal.map((item) => item.human_id), ["JSONL-2"]);
  } finally {
    fixture.close();
  }
});

test("configured fake source exposes default item and honors custom state filters", async () => {
  const defaultSource = createWorkSourceFromConfig(workflowConfig({ kind: "fake" }));
  const defaultCandidates = await defaultSource.fetchCandidateItems();

  assert.equal(defaultSource.kind, "fake");
  assert.equal(defaultCandidates.length, 1);
  assert.equal(defaultCandidates[0].source_id, "fake-work-item-1");
  assert.equal(defaultCandidates[0].human_id, "FAKE-1");
  assert.deepEqual(defaultCandidates[0].labels, ["symphony", "preview"]);
  assert.equal(defaultCandidates[0].metadata.work_source_kind, "fake");
  assert.deepEqual(await defaultSource.listTerminalItems(), []);

  const configuredSource = createWorkSourceFromConfig(workflowConfig({
    kind: "fake",
    active_states: ["Ready"],
    terminal_states: ["Archived"]
  }), {
    records: [
      record("ready-1", "SRC-READY", "Ready"),
      record("todo-1", "SRC-TODO", "Todo"),
      record("archived-1", "SRC-ARCHIVED", "Archived")
    ]
  });

  assert.deepEqual((await configuredSource.fetchCandidateItems()).map((item) => item.human_id), ["SRC-READY"]);
  assert.deepEqual((await configuredSource.listTerminalItems()).map((item) => item.human_id), ["SRC-ARCHIVED"]);
});

test("refresh matches work items by key, source id, and human id", async () => {
  const source = new FakeWorkSource([
    record("same-key", "KEY-1", "Todo", "Updated by exact key"),
    record("source-match", "SRC-CURRENT", "Todo", "Updated by source id"),
    record("human-current", "HUMAN-77", "Todo", "Updated by human id")
  ]);

  const requestedByKey = normalizeRecordToWorkItem(record("same-key", "KEY-1", "Todo", "Stale exact key"), "fake");
  const requestedBySourceId: WorkItem = {
    source: "gateway",
    source_id: "source-match",
    human_id: "SRC-STALE",
    title: "Stale source id",
    labels: [],
    metadata: { work_source_kind: "fake" }
  };
  const requestedByHumanId: WorkItem = {
    source: "symphony",
    human_id: "HUMAN-77",
    title: "Stale human id",
    labels: [],
    metadata: { work_source_kind: "fake" }
  };
  const missing = normalizeRecordToWorkItem(record("missing", "MISSING-1", "Todo"), "fake");

  const refreshed = await source.refreshItems([
    requestedByKey,
    requestedBySourceId,
    requestedByHumanId,
    missing
  ]);

  assert.equal(refreshed.get(workSourceIdentity(requestedByKey))?.title, "Updated by exact key");
  assert.equal(refreshed.get(workSourceIdentity(requestedBySourceId))?.title, "Updated by source id");
  assert.equal(refreshed.get(workSourceIdentity(requestedByHumanId))?.title, "Updated by human id");
  assert.equal(refreshed.get(workSourceIdentity(missing)), undefined);
});

function createFixture(): { root: string; close(): void } {
  const root = mkdtempSync(join(tmpdir(), "swarm-work-source-"));
  return {
    root,
    close: () => rmSync(root, { recursive: true, force: true })
  };
}

function workflowConfig(workSource: Partial<WorkflowRuntimeConfig["work_source"]>): WorkflowRuntimeConfig {
  return {
    work_source: {
      kind: workSource.kind ?? "local",
      path: workSource.path,
      active_states: workSource.active_states ?? ["Todo", "In Progress"],
      terminal_states: workSource.terminal_states ?? ["Done", "Closed", "Cancelled"]
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: tmpdir() },
    agent: { max_concurrent_agents: 2, max_retry_backoff_ms: 5_000 },
    hooks: { timeout_ms: 60_000 },
    cleanup: { retention: { min_age_ms: 0, keep_latest: 0, preserve_artifacts: false } }
  };
}

function record(id: string, identifier: string, state: string, title = `Work item ${identifier}`) {
  return {
    id,
    identifier,
    title,
    state,
    labels: ["test"]
  };
}
