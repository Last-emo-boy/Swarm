import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildWorkerToolProgressPayload,
  invalidWorkerLoopModelResult,
  parseWorkerLoopModelResult,
  repairWorkerLoopModelResult,
  validateWorkerLoopToolCalls
} from "./worker-loop-contract.js";

test("parseWorkerLoopModelResult parses full JSON worker result", () => {
  const parsed = parseWorkerLoopModelResult(JSON.stringify({
    status: "completed",
    summary: "Implemented tests",
    details: "Detailed report",
    files_touched: ["src/runtime/work-protocol.test.ts", 123],
    next_actions: ["Run npm test"],
    tool_calls: [{
      id: "call-1",
      action: "file.read",
      inputs: { path: "src/runtime/work-protocol.ts" },
      reason: "Inspect protocol"
    }]
  }));

  assert.equal(parsed.status, "completed");
  assert.equal(parsed.summary, "Implemented tests");
  assert.equal(parsed.details, "Detailed report");
  assert.deepEqual(parsed.files_touched, ["src/runtime/work-protocol.test.ts", "123"]);
  assert.deepEqual(parsed.next_actions, ["Run npm test"]);
  assert.deepEqual(parsed.tool_calls, [{
    id: "call-1",
    action: "file.read",
    inputs: { path: "src/runtime/work-protocol.ts" },
    reason: "Inspect protocol"
  }]);
});

test("parseWorkerLoopModelResult extracts embedded JSON and falls back to first detail line", () => {
  const parsed = parseWorkerLoopModelResult([
    "prefix",
    JSON.stringify({
      status: "failed",
      details: "First line\nSecond line",
      tool_calls: [{ type: "code.build", inputs: { command: "npm run check" } }]
    }),
    "suffix"
  ].join("\n"));

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.summary, "First line");
  assert.equal(parsed.tool_calls[0].action, "code.build");
});

test("parseWorkerLoopModelResult returns a completed fallback for non-JSON output", () => {
  const parsed = parseWorkerLoopModelResult("Plain worker summary\nwith details");

  assert.equal(parsed.status, "completed");
  assert.equal(parsed.summary, "Plain worker summary");
  assert.equal(parsed.details, "Plain worker summary\nwith details");
  assert.deepEqual(parsed.tool_calls, []);
});

test("validateWorkerLoopToolCalls accepts complete local tool calls", () => {
  const error = validateWorkerLoopToolCalls([
    { id: "read", action: "file.read", inputs: { path: "src/agents/worker-loop-contract.ts" } },
    { id: "build", action: "code.build", inputs: { command: "npm run check" } }
  ]);

  assert.equal(error, undefined);
});

test("validateWorkerLoopToolCalls rejects missing action and required inputs", () => {
  assert.match(
    validateWorkerLoopToolCalls([{ id: "missing-action", inputs: { path: "src/index.ts" } }]) ?? "",
    /empty or missing action/
  );
  assert.match(
    validateWorkerLoopToolCalls([{ id: "missing-path", action: "file.read", inputs: {} }]) ?? "",
    /missing required input/
  );
});

test("invalidWorkerLoopModelResult returns a failed repair result with retry guidance", () => {
  const result = invalidWorkerLoopModelResult("bad tool call", "x".repeat(3000));

  assert.equal(result.status, "failed");
  assert.match(result.summary, /Invalid worker tool call JSON/);
  assert(result.details.length < 2300);
  assert.deepEqual(result.tool_calls, []);
  assert(result.next_actions[0].includes("Retry the worker task"));
});

test("buildWorkerToolProgressPayload derives action, status, and optional fields", () => {
  const payload = buildWorkerToolProgressPayload({
    call: { id: "call-1", action: "file.read", inputs: { path: "src/index.ts" }, reason: "inspect" },
    result: {
      id: "result-1",
      action: "file.read",
      status: "failed",
      summary: "Could not read file\nextra detail",
      outputRef: "artifact://read",
      errorCode: "READ_FAILED",
      recoverySuggestion: "Check path",
      reason: "not found"
    },
    toolCallsCompleted: 2,
    remainingToolCalls: 1
  });

  assert.equal(payload.message, "Worker tool file.read failed: Could not read file");
  assert.equal(payload.tool_call_id, "result-1");
  assert.equal(payload.tool_calls_completed, 2);
  assert.equal(payload.remaining_tool_calls, 1);
  assert.equal(payload.errorCode, "READ_FAILED");
  assert.equal(payload.outputRef, "artifact://read");
  assert.equal(payload.recoverySuggestion, "Check path");
  assert.equal(payload.reason, "not found");
});

test("buildWorkerToolProgressPayload falls back to action from inputs and completed status", () => {
  const payload = buildWorkerToolProgressPayload({
    call: { id: "call-1", inputs: { action: "code.build" } },
    result: { id: "result-1", summary: "Build passed" },
    toolCallsCompleted: 1,
    remainingToolCalls: 0
  });

  assert.equal(payload.action, "code.build");
  assert.equal(payload.status, "completed");
  assert.equal(payload.message, "Worker tool code.build completed: Build passed");
});

test("repairWorkerLoopModelResult asks for JSON repair and returns parsed repaired output", async () => {
  const calls: unknown[] = [];
  const repaired = await repairWorkerLoopModelResult({
    originalText: "not json",
    validationError: "missing action",
    task: { objective: "test" },
    context: [{ file: "src/agents/worker-loop-contract.ts" }],
    loop: { turn: 1, remaining_turns: 2, remaining_tool_calls: 3 },
    cacheKey: "repair-key",
    maxOutputTokens: 400,
    generateText: async (input) => {
      calls.push(input);
      return JSON.stringify({
        status: "completed",
        summary: "Repaired",
        details: "Valid JSON",
        files_touched: [],
        next_actions: [],
        tool_calls: [{ action: "file.read", inputs: { path: "src/index.ts" } }]
      });
    }
  });

  assert.equal(repaired.status, "completed");
  assert.equal(repaired.summary, "Repaired");
  assert.equal(repaired.tool_calls[0].action, "file.read");
  assert.equal(calls.length, 1);
  const call = calls[0] as {
    responseFormat?: string;
    cache?: { key: string; ttlSeconds: number };
    maxOutputTokens?: number;
    user?: string;
  };
  assert.equal(call.responseFormat, "json_object");
  assert.deepEqual(call.cache, { key: "repair-key", ttlSeconds: 3600 });
  assert.equal(call.maxOutputTokens, 400);
  assert.match(call.user ?? "", /missing action/);
});

test("repairWorkerLoopModelResult returns invalid result when repaired tool calls remain malformed", async () => {
  const repaired = await repairWorkerLoopModelResult({
    originalText: "bad",
    validationError: "missing action",
    generateText: async () => JSON.stringify({
      status: "completed",
      summary: "Still bad",
      details: "No action",
      files_touched: [],
      next_actions: [],
      tool_calls: [{ inputs: { path: "src/index.ts" } }]
    })
  });

  assert.equal(repaired.status, "failed");
  assert.match(repaired.summary, /Invalid worker tool call JSON/);
  assert.deepEqual(repaired.tool_calls, []);
});
