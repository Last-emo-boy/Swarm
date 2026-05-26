import { strict as assert } from "node:assert";
import test from "node:test";
import {
  auditLegacyDirectPaths,
  DEFAULT_LEGACY_DIRECT_PATH_CRITICAL_WRITES,
  DEFAULT_LEGACY_DIRECT_PATH_EXCEPTIONS,
  REQUIRED_LEGACY_DIRECT_PATH_AREAS
} from "./legacy-direct-path-audit.js";

test("legacy direct-path audit requires every critical area to have adapter or explicit exception", () => {
  const audit = auditLegacyDirectPaths();
  assert.equal(audit.schema_version, "swarm.legacy_direct_path_audit.v1");
  assert.equal(audit.status, "pass");
  assert.equal(audit.summary.exceptions, DEFAULT_LEGACY_DIRECT_PATH_EXCEPTIONS.length);
  assert.equal(audit.summary.critical_writes, DEFAULT_LEGACY_DIRECT_PATH_CRITICAL_WRITES.length);
  assert(audit.summary.envelope_caused_writes > 0);
  assert(audit.summary.adapter_caused_writes > 0);
  assert.equal(audit.summary.errors, 0);
  for (const area of REQUIRED_LEGACY_DIRECT_PATH_AREAS) {
    assert(audit.exceptions.some((entry) => entry.area === area), `missing ${area} exception`);
    assert(audit.critical_writes.some((entry) => entry.area === area), `missing ${area} critical write policy`);
  }
  assert(audit.exceptions.every((entry) => entry.protocol_adapter.trim().length > 0));
  assert(audit.exceptions.every((entry) => entry.migration_task.startsWith("CAND-PROD-059-TASK-")));
  assert(audit.critical_writes.every((entry) => entry.cause !== "none"));
  assert(audit.critical_writes.every((entry) => entry.rationale.trim().length > 0));
});

test("legacy direct-path audit fails when a required area is not registered", () => {
  const audit = auditLegacyDirectPaths(
    DEFAULT_LEGACY_DIRECT_PATH_EXCEPTIONS.filter((entry) => entry.area !== "gateway")
  );
  assert.equal(audit.status, "fail");
  assert(audit.issues.some((issue) => issue.code === "missing_legacy_direct_path_policy" && issue.area === "gateway"));
});

test("legacy direct-path audit fails new critical writes without envelope cause or registered exception", () => {
  const audit = auditLegacyDirectPaths(
    DEFAULT_LEGACY_DIRECT_PATH_EXCEPTIONS,
    REQUIRED_LEGACY_DIRECT_PATH_AREAS,
    [
      ...DEFAULT_LEGACY_DIRECT_PATH_CRITICAL_WRITES,
      {
        id: "new-direct-task-write",
        area: "task",
        source: "src/runtime/new-direct-write.ts",
        symbol: "TaskStore.writeCriticalState",
        cause: "none",
        rationale: "Regression fixture for uncaused critical write guard."
      }
    ]
  );

  assert.equal(audit.status, "fail");
  assert(audit.issues.some((issue) =>
    issue.code === "critical_direct_write_without_protocol_cause" &&
    issue.area === "task" &&
    issue.message.includes("new-direct-task-write")
  ));
});

test("legacy direct-path audit fails critical writes that reference unknown exceptions", () => {
  const audit = auditLegacyDirectPaths(
    DEFAULT_LEGACY_DIRECT_PATH_EXCEPTIONS,
    REQUIRED_LEGACY_DIRECT_PATH_AREAS,
    [
      ...DEFAULT_LEGACY_DIRECT_PATH_CRITICAL_WRITES,
      {
        id: "unknown-adapter-write",
        area: "gateway",
        source: "src/server/gateway.ts",
        symbol: "gateway direct mutation",
        cause: "protocol_adapter",
        exception_id: "missing-exception",
        rationale: "Regression fixture for adapter registration guard."
      }
    ]
  );

  assert.equal(audit.status, "fail");
  assert(audit.issues.some((issue) =>
    issue.code === "critical_direct_write_unregistered_exception" &&
    issue.area === "gateway" &&
    issue.message.includes("missing-exception")
  ));
});
