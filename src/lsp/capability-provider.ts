import { LspManager, type LspProviderStatus, type LspStatusReport } from "./manager.js";
import { LSP_TOOL_ACTIONS, type LspCapabilityFact } from "./capabilities.js";
import type { CapabilityDescriptor, CapabilityDiagnostic, CapabilityProvider } from "../extensions/types.js";

export class LspCapabilityProvider implements CapabilityProvider {
  readonly id = "lsp";
  readonly title = "LSP semantic providers";
  private report?: LspStatusReport;
  private providerDiagnostics: CapabilityDiagnostic[] = [];

  constructor(private readonly input: { workspace: string; manager?: Pick<LspManager, "status"> }) {}

  async refresh(): Promise<void> {
    const manager = this.input.manager ?? new LspManager(this.input.workspace);
    this.providerDiagnostics = [];
    try {
      this.report = await manager.status();
      if (this.report.providers.every((provider) => !provider.detected)) {
        this.providerDiagnostics.push({
          severity: "info",
          code: "LSP_NO_PROVIDER",
          message: "No LSP provider manifests were detected in this workspace."
        });
      }
    } catch (error) {
      this.report = undefined;
      this.providerDiagnostics.push({
        severity: "error",
        code: "LSP_STATUS_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async listCapabilities(): Promise<CapabilityDescriptor[]> {
    if (!this.report && this.providerDiagnostics.length === 0) {
      await this.refresh();
    }
    return lspCapabilitiesFromStatus(this.report);
  }

  diagnostics(): CapabilityDiagnostic[] {
    return this.providerDiagnostics;
  }
}

export function lspCapabilitiesFromStatus(report: LspStatusReport | undefined): CapabilityDescriptor[] {
  if (!report) {
    return [];
  }
  return report.providers.flatMap((provider) => {
    const facts = provider.capabilities?.length
      ? provider.capabilities
      : LSP_TOOL_ACTIONS.map((action): LspCapabilityFact => ({
          action,
          available: false,
          mode: "unavailable",
          fallback_reason: provider.detected ? "provider_unavailable" : "provider_unavailable",
          reason: provider.reason ?? `${provider.providerId} provider not detected.`,
          next_action: provider.reason ?? `Install or configure the ${provider.providerId} LSP provider.`
        }));
    return facts.map((fact) => lspCapabilityDescriptor(report, provider, fact));
  });
}

function lspCapabilityDescriptor(
  report: LspStatusReport,
  provider: LspProviderStatus,
  fact: LspCapabilityFact
): CapabilityDescriptor {
  const providerState = lspProviderState(provider, fact);
  const actionName = fact.action.replace(/^lsp\./, "");
  const capabilityStatus: CapabilityDescriptor["status"] = providerState === "available" ? "available" :
    providerState === "failed" ? "failed" :
      provider.status === "starting" ? "pending" : "disabled";
  const trust: CapabilityDescriptor["trust"] = capabilityStatus === "disabled" ? "disabled" : "trusted";
  const diagnostics = lspDiagnostics(provider, fact, providerState);
  return {
    id: `lsp_tool.${provider.providerId}.${actionName}`,
    kind: "lsp_tool",
    source: "lsp",
    trust,
    providerId: `lsp:${provider.providerId}`,
    name: `lsp.${provider.providerId}.${actionName}`,
    title: `${provider.providerId} ${fact.action}`,
    description: fact.reason ?? `${fact.action} via ${provider.providerId} LSP provider state ${provider.status}.`,
    inputSchema: {
      type: "object",
      properties: {
        file: { description: "workspace file path" },
        line: { description: "1-based line for position actions" },
        column: { description: "1-based column for position actions" },
        query: { description: "workspace symbol query" }
      }
    },
    riskClass: "r0",
    permissionName: `Lsp(${provider.providerId}:${fact.action})`,
    modelVisible: false,
    userVisible: true,
    status: capabilityStatus,
    diagnostics,
    readOnly: true,
    concurrencyClass: "read_parallel",
    searchHint: `${provider.providerId} ${fact.action} ${fact.fallback_reason ?? ""}`.trim(),
    metadata: {
      provider_id: provider.providerId,
      provider_status: provider.status,
      participant_id: `capability:lsp:${provider.providerId}`,
      participant_state: providerState,
      action: fact.action,
      mode: fact.mode,
      available: fact.available,
      detected: provider.detected,
      generated_at: report.generatedAt,
      fallback_reason: fact.fallback_reason,
      fallback_tools: fact.fallback_tools,
      next_action: fact.next_action,
      recoverySuggestion: fact.next_action,
      reason: fact.reason ?? provider.reason,
      root: provider.root
    }
  };
}

function lspProviderState(provider: LspProviderStatus, fact: LspCapabilityFact): "available" | "no-provider" | "failed" | "degraded" {
  if (!provider.detected) {
    return "no-provider";
  }
  if (provider.status === "failed" || provider.status === "exited") {
    return "failed";
  }
  if (!fact.available || provider.status === "unavailable") {
    return "degraded";
  }
  return "available";
}

function lspDiagnostics(
  provider: LspProviderStatus,
  fact: LspCapabilityFact,
  state: ReturnType<typeof lspProviderState>
): CapabilityDiagnostic[] {
  const diagnostics: CapabilityDiagnostic[] = [];
  if (state === "no-provider") {
    diagnostics.push({
      severity: "info",
      code: "LSP_NO_PROVIDER",
      message: fact.next_action ?? provider.reason ?? `${provider.providerId} provider not detected.`
    });
  }
  if (state === "failed") {
    diagnostics.push({
      severity: "error",
      code: "LSP_PROVIDER_FAILED",
      message: provider.lastError ?? fact.reason ?? `${provider.providerId} provider failed.`
    });
  }
  if (state === "degraded") {
    diagnostics.push({
      severity: "warn",
      code: fact.fallback_reason?.toUpperCase() ?? "LSP_DEGRADED",
      message: fact.next_action ?? fact.reason ?? `${fact.action} is degraded.`
    });
  }
  return diagnostics;
}
