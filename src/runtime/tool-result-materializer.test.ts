import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { materializeToolOutput, truncateMiddle } from "./tool-result-materializer.js";

test("materializeToolOutput keeps short successful output inline", async () => {
  const fixture = createFixture();
  try {
    const result = await materializeToolOutput({
      sessionId: "session-short",
      taskId: "task-short",
      detail: "short output",
      result: {
        status: "success",
        outputRef: "existing-output-ref",
        metadata: { source: "metadata" }
      },
      maxInlineBytes: 100,
      previewBytes: 20
    });

    assert.deepEqual(result, {
      content: "short output",
      outputRef: "existing-output-ref",
      data: { source: "metadata" }
    });
  } finally {
    fixture.close();
  }
});

test("materializeToolOutput persists and previews long output", async () => {
  const fixture = createFixture();
  try {
    const detail = `${"a".repeat(60)}\n${"b".repeat(60)}\n${"c".repeat(60)}`;
    const result = await materializeToolOutput({
      sessionId: "session-long",
      taskId: "task-long",
      detail,
      result: {
        status: "success",
        data: { source: "data" }
      },
      maxInlineBytes: 50,
      previewBytes: 30
    });

    assert.ok(result.outputRef);
    assert.equal(readFileSync(result.outputRef!, "utf8"), detail);
    assert.match(result.content ?? "", /\[\.\.\. \d+ bytes omitted from 3 lines\. Full output:/);
    assert.notEqual(result.content, detail);
    assert.equal((result.data as { source?: unknown }).source, "data");
    const ref = (result.data as { outputRef?: { path?: string; bytes?: number; lines?: number } }).outputRef;
    assert.equal(ref?.path, result.outputRef);
    assert.equal(ref?.lines, 3);
    assert.equal(ref?.bytes, Buffer.byteLength(detail, "utf8"));
  } finally {
    fixture.close();
  }
});

test("materializeToolOutput persists only above the inline byte threshold and preserves attempt", async () => {
  const fixture = createFixture();
  try {
    const inlineDetail = "x".repeat(8_000);
    const inline = await materializeToolOutput({
      sessionId: "session-boundary",
      taskId: "task-boundary",
      detail: inlineDetail,
      result: { status: "success" },
      maxInlineBytes: 8_000,
      previewBytes: 2_000,
      attempt: 7
    });
    assert.deepEqual(inline, { content: inlineDetail, outputRef: undefined, data: undefined });

    const persistedDetail = "x".repeat(8_001);
    const persisted = await materializeToolOutput({
      sessionId: "session-boundary",
      taskId: "task-boundary",
      detail: persistedDetail,
      result: { status: "success" },
      maxInlineBytes: 8_000,
      previewBytes: 2_000,
      attempt: 7
    });

    assert.ok(persisted.outputRef);
    assert.equal(basename(persisted.outputRef!), "task-boundary.7.output");
    assert.equal(readFileSync(persisted.outputRef!, "utf8"), persistedDetail);
    assert.match(persisted.content ?? "", /Full output:/);
  } finally {
    fixture.close();
  }
});

test("materializeToolOutput persists failed short output without truncating it", async () => {
  const fixture = createFixture();
  try {
    const result = await materializeToolOutput({
      sessionId: "session-failed",
      taskId: "task-failed",
      detail: "short failure detail",
      result: {
        status: "failed",
        data: "raw-data"
      },
      maxInlineBytes: 100,
      previewBytes: 20,
      persistFailed: true
    });

    assert.ok(result.outputRef);
    assert.equal(result.content, "short failure detail");
    assert.equal(readFileSync(result.outputRef!, "utf8"), "short failure detail");
    assert.equal((result.data as { value?: unknown }).value, "raw-data");
    assert.equal(typeof (result.data as { outputRef?: { path?: unknown } }).outputRef?.path, "string");
  } finally {
    fixture.close();
  }
});

test("materializeToolOutput wraps undefined persisted data by default", async () => {
  const fixture = createFixture();
  try {
    const result = await materializeToolOutput({
      sessionId: "session-undefined-default",
      taskId: "task-undefined-default",
      detail: "failure without data",
      result: {
        status: "failed"
      },
      maxInlineBytes: 100,
      previewBytes: 20,
      persistFailed: true
    });

    assert.ok(result.outputRef);
    assert.equal(readFileSync(result.outputRef!, "utf8"), "failure without data");
    assert.equal(Object.hasOwn(result.data as Record<string, unknown>, "value"), true);
    assert.equal((result.data as { value?: unknown }).value, undefined);
    assert.equal(typeof (result.data as { outputRef?: { path?: unknown } }).outputRef?.path, "string");
  } finally {
    fixture.close();
  }
});

test("materializeToolOutput can attach outputRef without wrapping undefined data", async () => {
  const fixture = createFixture();
  try {
    const result = await materializeToolOutput({
      sessionId: "session-undefined-unwrapped",
      taskId: "task-undefined-unwrapped",
      detail: "child failure without data",
      result: {
        status: "failed"
      },
      maxInlineBytes: 100,
      previewBytes: 20,
      persistFailed: true,
      wrapUndefinedData: false
    });

    assert.ok(result.outputRef);
    assert.equal(readFileSync(result.outputRef!, "utf8"), "child failure without data");
    assert.deepEqual(Object.keys(result.data as Record<string, unknown>), ["outputRef"]);
    assert.equal(typeof (result.data as { outputRef?: { path?: unknown } }).outputRef?.path, "string");
  } finally {
    fixture.close();
  }
});

test("truncateMiddle uses the same full-output marker as runtime previews", () => {
  const content = "0123456789".repeat(10);
  const truncated = truncateMiddle(content, 20, 100, 1, "/tmp/output");
  assert.match(truncated, /\[\.\.\. 80 bytes omitted from 1 lines\. Full output: \/tmp\/output\]/);
  assert.ok(truncated.startsWith("01234567890123"));
  assert.ok(truncated.endsWith("456789"));
});

test("truncateMiddle can preserve slash preview boundary behavior", () => {
  const content = `${"a".repeat(20)}\uFFFD${"b".repeat(80)}`;
  const truncated = truncateMiddle(content, 30, Buffer.byteLength(content, "utf8"), 1, "/tmp/slash-output", {
    minHeadBytes: 23,
    minTailBytes: 10,
    trimReplacementCharacters: true
  });

  assert.doesNotMatch(truncated.split("\n")[0] ?? "", /\uFFFD$/u);
  assert.match(truncated, /Full output: \/tmp\/slash-output/);
  assert.ok(truncated.endsWith("bbbbbbbbbb"));
});

function createFixture(): { close(): void } {
  const root = mkdtempSync(join(tmpdir(), "swarm-tool-result-materializer-"));
  const previousHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = root;
  return {
    close: () => {
      if (previousHome === undefined) {
        delete process.env.SWARM_HOME;
      } else {
        process.env.SWARM_HOME = previousHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}
