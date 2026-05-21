import { strict as assert } from "node:assert";
import test from "node:test";
import { buildResumeCommandResult, decideResumeExecution } from "./resume-control.js";

test("resume command result stays in the input flow without auto-open metadata", () => {
  const execution = decideResumeExecution({
    command: "continue",
    sessionId: "session-123",
    hasStoredPlan: false,
    instruction: ""
  });

  const result = buildResumeCommandResult({
    command: "continue",
    sessionId: "session-123",
    route: execution.route,
    detail: "Preflight detail"
  });

  assert.equal(result.brief, "Continue started for session-123 through local coding loop. Ctrl+O for preflight.");
  assert.equal(result.detail, "Preflight detail");
  assert.equal(Object.hasOwn(result, "autoOpenDetail"), false);
});

test("resume execution keeps the coding loop route for non-stored sessions", () => {
  const execution = decideResumeExecution({
    command: "resume",
    sessionId: "session-456",
    hasStoredPlan: false,
    instruction: ""
  });

  assert.equal(execution.route, "coding_loop");
});
