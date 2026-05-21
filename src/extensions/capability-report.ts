import type { SwarmRuntime } from "../runtime/runtime.js";
import type { ToolResult } from "../tools/types.js";
import { summarizeCapabilityCatalog } from "./catalog-summary.js";
import type { CapabilityDescriptor, CapabilityFilter, CapabilityProviderSnapshot } from "./types.js";

export type CapabilitySelectorResolution = {
  capabilityId?: string;
  error?: string;
};

export type CapabilityCliFilter = {
  kind?: string;
  providerId?: string;
  query?: string;
};

export type CapabilityCliReport = {
  detail: string;
  data: Record<string, unknown>;
};

export async function buildCapabilityListReport(
  runtime: SwarmRuntime,
  options: {
    filter?: CapabilityCliFilter;
    includeDisabled?: boolean;
    advanced?: boolean;
  } = {}
): Promise<CapabilityCliReport> {
  const filter: CapabilityFilter = {
    ...options.filter,
    includeDisabled: options.includeDisabled === true
  };
  const [capabilities, providers] = await Promise.all([
    runtime.listCapabilities(filter),
    runtime.listCapabilityProviders()
  ]);
  const summary = summarizeCapabilityCatalog(capabilities, providers);
  const settings = capabilitySettingsSnapshot(runtime);
  const lines = [
    "Swarm Capabilities",
    `workspace=${runtime.getWorkspacePath()}`,
    `settings disabled_ids=${settings.disabled.length} hidden_ids=${settings.hidden_from_model.length}`,
    `filters kind=${options.filter?.kind ?? "(none)"} provider=${options.filter?.providerId ?? "(none)"} query=${options.filter?.query ?? "(none)"} include_disabled=${options.includeDisabled === true ? "yes" : "no"}`,
    `summary capabilities=${summary.totals.capabilities} providers=${summary.totals.providers} ready=${summary.totals.ready} model_visible=${summary.totals.modelVisible} hidden=${summary.totals.hidden} disabled=${summary.totals.disabled} user_visible=${summary.totals.userVisible}`,
    ""
  ];
  const detail = options.advanced || hasCapabilityCliFilter(options.filter)
    ? formatCapabilities(capabilities, providers)
    : formatCapabilitySummary(summary);
  return {
    detail: [...lines, detail].join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      settings,
      filter: options.filter ?? {},
      include_disabled: options.includeDisabled === true,
      advanced: options.advanced === true,
      summary,
      providers,
      capabilities
    }
  };
}

export async function buildCapabilityDetailReport(runtime: SwarmRuntime, selector?: string): Promise<CapabilityCliReport> {
  const resolution = await resolveCapabilitySelector(runtime, selector);
  if (!resolution.capabilityId) {
    throw new Error(resolution.error ?? `Unknown capability: ${selector ?? "(missing)"}`);
  }
  const capability = await runtime.getCapability(resolution.capabilityId);
  if (!capability) {
    throw new Error(`Unknown capability: ${resolution.capabilityId}`);
  }
  const providers = await runtime.listCapabilityProviders();
  const provider = providers.find((item) => item.providerId === capability.providerId);
  const lines = [
    "Swarm Capability",
    `workspace=${runtime.getWorkspacePath()}`,
    `capability=${capability.id} kind=${capability.kind} source=${capability.source} provider=${capability.providerId}`,
    `trust=${capability.trust} status=${capability.status ?? "available"} risk=${capability.riskClass} permission=${capability.permissionName}`,
    `visibility model=${capability.modelVisible ? "yes" : "no"} user=${capability.userVisible ? "yes" : "no"} read_only=${capability.readOnly === true ? "yes" : "no"} concurrency=${capability.concurrencyClass ?? "(none)"}`,
    capability.searchHint ? `search_hint=${capability.searchHint}` : undefined,
    "",
    "Title",
    capability.title ?? capability.name,
    "",
    "Description",
    capability.description
  ].filter(Boolean);
  if (capability.inputSchema !== undefined) {
    lines.push("");
    lines.push("Input Schema");
    lines.push(JSON.stringify(capability.inputSchema, null, 2));
  }
  if (capability.metadata && Object.keys(capability.metadata).length) {
    lines.push("");
    lines.push("Metadata");
    lines.push(JSON.stringify(capability.metadata, null, 2));
  }
  if (capability.diagnostics?.length) {
    lines.push("");
    lines.push("Diagnostics");
    for (const diagnostic of capability.diagnostics) {
      lines.push(`  ${diagnostic.severity}: ${diagnostic.code ?? "diagnostic"} ${diagnostic.message}`);
    }
  }
  if (provider) {
    lines.push("");
    lines.push("Provider");
    lines.push(`${provider.providerId} capabilities=${provider.capabilities}`);
    if (provider.diagnostics.length) {
      for (const diagnostic of provider.diagnostics) {
        lines.push(`  ${diagnostic.severity}: ${diagnostic.code ?? "diagnostic"} ${diagnostic.message}`);
      }
    }
  }
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      settings: capabilitySettingsSnapshot(runtime),
      capability,
      provider
    }
  };
}

export async function buildCapabilityInvocationReport(
  runtime: SwarmRuntime,
  selector: string,
  args: Record<string, unknown>,
  options: {
    sessionId?: string;
    writePolicy?: "read_only" | "scoped_write" | "workspace_write";
    fileScope?: string[];
  } = {}
): Promise<CapabilityCliReport> {
  const resolution = await resolveCapabilitySelector(runtime, selector);
  if (!resolution.capabilityId) {
    throw new Error(resolution.error ?? `Unknown capability: ${selector}`);
  }
  const capability = await runtime.getCapability(resolution.capabilityId);
  if (!capability) {
    throw new Error(`Unknown capability: ${resolution.capabilityId}`);
  }
  const result = await runtime.invokeCapability(capability.id, args, options.sessionId, {
    source: "runtime",
    title: `CLI invoke ${capability.title ?? capability.name}`,
    writePolicy: options.writePolicy,
    fileScope: options.fileScope
  });
  const lines = [
    "Swarm Capability Invoke",
    `workspace=${runtime.getWorkspacePath()}`,
    `capability=${capability.id} provider=${capability.providerId} kind=${capability.kind}`,
    options.sessionId ? `session=${options.sessionId}` : undefined,
    `write_policy=${options.writePolicy ?? (capability.readOnly === true ? "read_only" : "workspace_write")}`,
    options.fileScope?.length ? `file_scope=${options.fileScope.join(", ")}` : undefined,
    `arguments=${JSON.stringify(args)}`,
    "",
    formatToolResult(result)
  ].filter(Boolean);
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      capability,
      session_id: options.sessionId,
      write_policy: options.writePolicy,
      file_scope: options.fileScope,
      arguments: args,
      result
    }
  };
}

export async function resolveCapabilitySelector(runtime: SwarmRuntime, query?: string): Promise<CapabilitySelectorResolution> {
  const trimmed = query?.trim();
  if (!trimmed) {
    return { error: "Capability id is required." };
  }
  const capabilities = await runtime.listCapabilities({ includeDisabled: true });
  const exact = capabilities.find((capability) => capability.id === trimmed);
  if (exact) {
    return { capabilityId: exact.id };
  }
  const normalized = trimmed.toLowerCase();
  const exactInsensitive = capabilities.find((capability) => capability.id.toLowerCase() === normalized);
  if (exactInsensitive) {
    return { capabilityId: exactInsensitive.id };
  }
  const exactName = capabilities.find((capability) => capability.name.toLowerCase() === normalized);
  if (exactName) {
    return { capabilityId: exactName.id };
  }
  const prefixMatches = capabilities.filter((capability) =>
    capability.id.toLowerCase().startsWith(normalized) ||
    capability.name.toLowerCase().startsWith(normalized)
  );
  if (prefixMatches.length === 1) {
    return { capabilityId: prefixMatches[0].id };
  }
  if (prefixMatches.length > 1) {
    return {
      error: `Ambiguous capability selector: ${trimmed}. Matches: ${prefixMatches.slice(0, 6).map((capability) => capability.id).join(", ")}`
    };
  }
  const fuzzyMatches = capabilities.filter((capability) =>
    [
      capability.id,
      capability.name,
      capability.title ?? "",
      capability.description,
      capability.providerId,
      capability.permissionName,
      capability.searchHint ?? ""
    ].some((value) => value.toLowerCase().includes(normalized))
  );
  if (fuzzyMatches.length === 1) {
    return { capabilityId: fuzzyMatches[0].id };
  }
  if (fuzzyMatches.length > 1) {
    return {
      error: `Ambiguous capability selector: ${trimmed}. Matches: ${fuzzyMatches.slice(0, 6).map((capability) => capability.id).join(", ")}`
    };
  }
  return { error: `Unknown capability: ${trimmed}` };
}

export function hasCapabilityCliFilter(filter?: CapabilityCliFilter): boolean {
  return Boolean(filter?.kind || filter?.providerId || filter?.query);
}

function capabilitySettingsSnapshot(runtime: SwarmRuntime): {
  disabled: string[];
  hidden_from_model: string[];
} {
  return {
    disabled: [...runtime.settings.extensions.capabilities.disabled],
    hidden_from_model: [...runtime.settings.extensions.capabilities.hiddenFromModel]
  };
}

function formatCapabilities(capabilities: CapabilityDescriptor[], providers: CapabilityProviderSnapshot[]): string {
  const providerLines = [...providers]
    .sort((left, right) => right.capabilities - left.capabilities || left.providerId.localeCompare(right.providerId))
    .map((provider) => {
      const diagnostics = provider.diagnostics.length
        ? ` diagnostics=${provider.diagnostics.map((item) => item.code ?? item.severity).join(",")}`
        : "";
      return `${provider.providerId}: ${provider.capabilities} capabilities${diagnostics}`;
    });
  const grouped = new Map<string, CapabilityDescriptor[]>();
  for (const capability of capabilities) {
    grouped.set(capability.kind, [...(grouped.get(capability.kind) ?? []), capability]);
  }
  const capabilityLines = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([kind, rows]) => [
      "",
      kind,
      ...rows.map((capability) => [
        `  ${capability.id} [${capability.providerId}/${capability.trust}/${capability.riskClass}/${capability.status ?? "available"}]`,
        `    ${capability.title ?? capability.name}`,
        `    ${capability.description}`,
        `    permission=${capability.permissionName} model=${capability.modelVisible ? "yes" : "no"} user=${capability.userVisible ? "yes" : "no"} read_only=${capability.readOnly === true ? "yes" : "no"} concurrency=${capability.concurrencyClass ?? "(none)"}`,
        capability.searchHint ? `    search=${capability.searchHint}` : undefined
      ].filter(Boolean).join("\n"))
    ]);
  return [
    "Providers",
    ...(providerLines.length ? providerLines : ["No providers registered."]),
    ...(capabilityLines.length ? capabilityLines : ["", "No capabilities matched."])
  ].join("\n");
}

function formatCapabilitySummary(summary: ReturnType<typeof summarizeCapabilityCatalog>): string {
  if (summary.totals.capabilities === 0) {
    return [
      "Capability summary",
      "No capabilities discovered.",
      "Use `swarm capabilities --all` after loading skills, plugins, or MCP servers."
    ].join("\n");
  }
  return [
    "Capability summary",
    `${summary.totals.capabilities} capabilities across ${summary.totals.providers} providers.`,
    `Ready=${summary.totals.ready} model-visible=${summary.totals.modelVisible} hidden=${summary.totals.hidden}.`,
    "",
    "By kind",
    ...summary.byKind.map((item) => `  ${item.kind}: ${item.count}`),
    "",
    "Top surfaces",
    ...(summary.topCapabilities.length
      ? summary.topCapabilities.map((item) => `  ${item.id} - ${item.title} [${item.kind}/${item.providerId}]`)
      : ["  (none)"]),
    "",
    "Provider health",
    ...(summary.providers.length
      ? summary.providers.map((provider) => {
          const diagnostics = provider.diagnostics.length
            ? ` diagnostics=${provider.diagnostics.map((item) => item.code ?? item.severity).join(",")}`
            : "";
          return `  ${provider.providerId}: ${provider.capabilities} capabilities${diagnostics}`;
        })
      : ["  (none)"]),
    ...(summary.diagnostics.length
      ? ["", "Diagnostics", ...summary.diagnostics.map((item) => `  ${item.providerId}: ${item.code ?? "diagnostic"} ${item.message}`)]
      : []),
    "",
    "Use `swarm capabilities --all` for the full catalog."
  ].join("\n");
}

function formatToolResult(result: ToolResult): string {
  return [
    `status=${result.status ?? "success"} action=${result.action}`,
    `summary=${result.summary}`,
    result.errorCode ? `error_code=${result.errorCode}` : undefined,
    result.retryable !== undefined ? `retryable=${result.retryable ? "yes" : "no"}` : undefined,
    result.recoverable !== undefined ? `recoverable=${result.recoverable ? "yes" : "no"}` : undefined,
    result.recoverySuggestion ? `recovery=${result.recoverySuggestion}` : undefined,
    result.outputRef ? `output_ref=${result.outputRef}` : undefined,
    result.errors?.length ? `errors=\n${result.errors.map((item) => `  ${item}`).join("\n")}` : undefined,
    result.content ? `content=\n${result.content}` : undefined,
    result.data !== undefined ? `data=\n${JSON.stringify(result.data, null, 2)}` : undefined,
    result.metadata && Object.keys(result.metadata).length ? `metadata=\n${JSON.stringify(result.metadata, null, 2)}` : undefined
  ].filter(Boolean).join("\n");
}
