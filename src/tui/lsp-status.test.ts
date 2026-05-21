import { strict as assert } from "node:assert";
import test from "node:test";
import type { LspProviderStatus, LspStatusReport } from "../lsp/manager.js";
import { lspHealthStatusFromReport } from "./lsp-status.js";

test("lsp health maps TypeScript semantic fallback to ready", () => {
  assert.equal(lspHealthStatusFromReport(report([
    provider({ providerId: "typescript", status: "ready", detected: true, available: true })
  ])), "ready");
});

test("lsp health maps detected missing provider to unavailable", () => {
  assert.equal(lspHealthStatusFromReport(report([
    provider({
      providerId: "python",
      status: "unavailable",
      detected: true,
      available: false,
      reason: "Install pyright-langserver or set SWARM_LSP_PYTHON_COMMAND."
    }),
    provider({ providerId: "typescript", status: "ready", detected: false, available: true })
  ])), "unavailable");
});

test("lsp health maps exited providers to failed", () => {
  assert.equal(lspHealthStatusFromReport(report([
    provider({ providerId: "typescript", status: "exited", detected: true, available: true, lastError: "server exited" })
  ])), "failed");
});

test("lsp health ignores undetected providers and reports empty state as unknown", () => {
  assert.equal(lspHealthStatusFromReport(report([])), "unknown");
  assert.equal(lspHealthStatusFromReport(report([
    provider({ providerId: "python", status: "unavailable", detected: false, available: false })
  ])), "unknown");
});

test("lsp health treats installed stopped providers as ready and external providers as external", () => {
  assert.equal(lspHealthStatusFromReport(report([
    provider({ providerId: "go", status: "stopped", detected: true, available: true })
  ])), "ready");
  assert.equal(lspHealthStatusFromReport(report([
    provider({ providerId: "rust", status: "external", detected: true, available: true, pid: 1234 })
  ])), "external");
});

function report(providers: LspProviderStatus[]): LspStatusReport {
  return {
    workspace: "E:\\Playground\\Swarm",
    generatedAt: "2026-05-21T00:00:00.000Z",
    providers
  };
}

function provider(input: Partial<LspProviderStatus> & Pick<LspProviderStatus, "providerId" | "status">): LspProviderStatus {
  return {
    root: "E:\\Playground\\Swarm",
    languageIds: [],
    logPath: "lsp.log",
    metadataPath: "lsp.json",
    detected: true,
    available: true,
    ...input
  };
}
