import { strict as assert } from "node:assert";
import test from "node:test";
import { lspCapabilitiesFromStatus } from "./capability-provider.js";
import type { LspProviderStatus, LspStatusReport } from "./manager.js";

test("LSP no-provider status is projected as disabled capability participant evidence", () => {
  const capabilities = lspCapabilitiesFromStatus(report({
    providerId: "python",
    status: "unavailable",
    detected: false,
    available: false,
    reason: "Install pyright-langserver or set SWARM_LSP_PYTHON_COMMAND."
  }));

  const hover = capabilities.find((capability) => capability.id === "lsp_tool.python.hover");
  assert(hover, "expected python hover LSP capability");
  assert.equal(hover.kind, "lsp_tool");
  assert.equal(hover.source, "lsp");
  assert.equal(hover.providerId, "lsp:python");
  assert.equal(hover.status, "disabled");
  assert.equal(hover.trust, "disabled");
  assert.equal(hover.metadata?.participant_id, "capability:lsp:python");
  assert.equal(hover.metadata?.participant_state, "no-provider");
  assert.match(String(hover.metadata?.recoverySuggestion), /Install pyright-langserver/);
  assert.equal(hover.diagnostics?.some((diagnostic) => diagnostic.code === "LSP_NO_PROVIDER"), true);
});

test("LSP failed provider status is projected with recovery diagnostics", () => {
  const capabilities = lspCapabilitiesFromStatus(report({
    providerId: "rust",
    status: "failed",
    detected: true,
    available: false,
    lastError: "rust-analyzer exited unexpectedly",
    capabilities: [{
      action: "lsp.hover",
      available: false,
      mode: "file_tools_fallback",
      fallback_reason: "provider_failed",
      reason: "rust-analyzer exited unexpectedly",
      next_action: "Restart the LSP provider or use file.grep/file.read."
    }]
  }));

  const hover = capabilities.find((capability) => capability.id === "lsp_tool.rust.hover");
  assert(hover, "expected rust hover LSP capability");
  assert.equal(hover.status, "failed");
  assert.equal(hover.trust, "trusted");
  assert.equal(hover.metadata?.participant_id, "capability:lsp:rust");
  assert.equal(hover.metadata?.participant_state, "failed");
  assert.match(String(hover.metadata?.recoverySuggestion), /Restart the LSP provider/);
  assert.equal(hover.diagnostics?.some((diagnostic) => diagnostic.code === "LSP_PROVIDER_FAILED"), true);
});

function report(provider: Partial<LspProviderStatus> & Pick<LspProviderStatus, "providerId">): LspStatusReport {
  return {
    workspace: "E:/workspace",
    generatedAt: "2026-05-26T00:00:00.000Z",
    providers: [{
      providerId: provider.providerId,
      root: "E:/workspace",
      status: provider.status ?? "stopped",
      languageIds: [],
      logPath: `E:/workspace/.swarm/lsp/${provider.providerId}.log`,
      metadataPath: `E:/workspace/.swarm/lsp/${provider.providerId}.json`,
      detected: provider.detected ?? true,
      available: provider.available ?? true,
      command: provider.command,
      args: provider.args,
      lastError: provider.lastError,
      reason: provider.reason,
      capabilities: provider.capabilities
    }]
  };
}
