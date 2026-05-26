import { strict as assert } from "node:assert";
import test from "node:test";
import type { LspProviderStatus, LspStatusReport } from "../lsp/manager.js";
import { lspHealthStatusFromReport, lspStatusSummaryFromReport } from "./lsp-status.js";

test("lsp health maps TypeScript semantic fallback to ready", () => {
  assert.equal(lspHealthStatusFromReport(report([
    provider({ providerId: "typescript", status: "ready", detected: true, available: true })
  ])), "ready");
});

test("lsp health maps detected missing provider to not-configured", () => {
  assert.equal(lspHealthStatusFromReport(report([
    provider({
      providerId: "python",
      status: "unavailable",
      detected: true,
      available: false,
      reason: "Install pyright-langserver or set SWARM_LSP_PYTHON_COMMAND."
    }),
    provider({ providerId: "typescript", status: "ready", detected: false, available: true })
  ])), "not-configured");
});

test("lsp health maps exited providers to failed", () => {
  assert.equal(lspHealthStatusFromReport(report([
    provider({ providerId: "typescript", status: "exited", detected: true, available: true, lastError: "server exited" })
  ])), "failed");
});

test("lsp health reports undetected providers as no-provider and empty report as unknown", () => {
  assert.equal(lspHealthStatusFromReport(report([])), "unknown");
  const summary = lspStatusSummaryFromReport(report([
    provider({ providerId: "python", status: "unavailable", detected: false, available: false })
  ]));
  assert.equal(summary.health, "no-provider");
  assert.equal(summary.providers, 0);
  assert.match(summary.nextActions[0] ?? "", /python/i);
});

test("lsp health treats installed stopped providers as ready and external providers as external", () => {
  assert.equal(lspHealthStatusFromReport(report([
    provider({ providerId: "go", status: "stopped", detected: true, available: true })
  ])), "ready");
  assert.equal(lspHealthStatusFromReport(report([
    provider({ providerId: "rust", status: "external", detected: true, available: true, pid: 1234 })
  ])), "external");
});

test("lsp summary exposes semantic graph fallback and stale reasons", () => {
  const summary = lspStatusSummaryFromReport(report([
    provider({
      providerId: "typescript",
      status: "ready",
      detected: true,
      available: true,
      capabilities: [
        {
          action: "lsp.definition",
          available: true,
          mode: "typescript_semantic_fallback",
          fallback_reason: "semantic_fallback",
          reason: "Using in-process TypeScript semantic provider fallback.",
          next_action: "Semantic tools are available locally.",
          fallback_tools: ["file.grep", "file.read"]
        },
        {
          action: "lsp.rename_preview",
          available: false,
          mode: "file_tools_fallback",
          fallback_reason: "partial_capability",
          reason: "LSP provider did not advertise rename.",
          next_action: "Use file.grep/file.read for this query.",
          fallback_tools: ["file.grep", "file.read"]
        }
      ]
    })
  ]));

  assert.equal(summary.health, "partial");
  assert.equal(summary.semanticGraphHealth, "partial");
  assert.deepEqual(summary.semanticEvidenceSources, ["typescript_semantic_fallback", "file_tools_fallback"]);
  assert.deepEqual(summary.staleReasons, ["partial_capability"]);
  assert.deepEqual(summary.fallbackReasons, ["semantic_fallback", "partial_capability"]);
  assert.deepEqual(summary.nextActions, ["Semantic tools are available locally.", "Use file.grep/file.read for this query."]);
});

test("lsp summary ignores undetected provider capability fallbacks", () => {
  const summary = lspStatusSummaryFromReport(report([
    provider({
      providerId: "typescript",
      status: "ready",
      detected: true,
      available: true,
      capabilities: [
        {
          action: "lsp.definition",
          available: true,
          mode: "typescript_semantic_fallback",
          fallback_reason: "semantic_fallback"
        }
      ]
    }),
    provider({
      providerId: "python",
      status: "unavailable",
      detected: false,
      available: false,
      capabilities: [
        {
          action: "lsp.definition",
          available: false,
          mode: "unavailable",
          fallback_reason: "unknown",
          next_action: "Install pyright-langserver."
        }
      ]
    })
  ]));

  assert.equal(summary.health, "fallback");
  assert.equal(summary.providers, 1);
  assert.equal(summary.unavailableProviders, 0);
  assert.deepEqual(summary.fallbackReasons, ["semantic_fallback"]);
  assert.deepEqual(summary.staleReasons, []);
  assert.deepEqual(summary.nextActions, []);
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
