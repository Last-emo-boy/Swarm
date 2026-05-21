import type { LspProviderStatus, LspStatusReport } from "../lsp/manager.js";

export type TuiLspHealthStatus = "ready" | "external" | "starting" | "unavailable" | "failed" | "unknown";

export function lspHealthStatusFromReport(report: LspStatusReport | undefined): TuiLspHealthStatus {
  const relevant = report?.providers.filter((provider) => provider.detected) ?? [];
  if (relevant.length === 0) {
    return "unknown";
  }
  if (relevant.some((provider) => provider.status === "failed" || provider.status === "exited")) {
    return "failed";
  }
  if (relevant.some((provider) => provider.status === "unavailable" || !provider.available)) {
    return "unavailable";
  }
  if (relevant.some((provider) => provider.status === "starting")) {
    return "starting";
  }
  if (relevant.some((provider) => provider.status === "external")) {
    return "external";
  }
  if (relevant.some(providerIsReadyLike)) {
    return "ready";
  }
  return "unknown";
}

function providerIsReadyLike(provider: LspProviderStatus): boolean {
  return provider.status === "ready" || (provider.status === "stopped" && provider.available);
}
