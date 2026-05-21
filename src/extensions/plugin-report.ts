import type { SwarmRuntime } from "../runtime/runtime.js";
import { summarizePluginCatalog } from "./catalog-summary.js";
import type { PluginRecord } from "./plugins.js";
import type { CapabilityDiagnostic } from "./types.js";

export type PluginSelectorResolution = {
  pluginId?: string;
  error?: string;
};

export type PluginCliReport = {
  detail: string;
  data: Record<string, unknown>;
  ok?: boolean;
  warnings?: number;
  failures?: number;
};

type PluginDiagnosticRecord = {
  plugin_id: string;
  severity: CapabilityDiagnostic["severity"];
  code?: string;
  message: string;
  contribution?: string;
};

export function buildPluginListReport(runtime: SwarmRuntime): PluginCliReport {
  const plugins = runtime.listPlugins();
  const summary = summarizePluginCatalog(plugins);
  const totals = pluginTotals(plugins);
  const settings = pluginSettingsSnapshot(runtime);
  const lines = [
    "Swarm Plugins",
    `workspace=${runtime.getWorkspacePath()}`,
    `settings enabled=${settings.enabled ? "yes" : "no"} load_project=${settings.load_project_plugins} configured_roots=${settings.configured_roots.length} disabled_ids=${settings.disabled.length} max=${settings.max_plugins}`,
    `summary plugins=${summary.totals.plugins} trusted=${summary.totals.trusted} disabled=${totals.disabled} untrusted=${totals.untrusted} contributions=${summary.totals.contributions} slash_commands=${summary.totals.slashCommands}`,
    ""
  ];
  if (!plugins.length) {
    lines.push("No plugins discovered.");
    lines.push("");
    lines.push("Use `swarm plugins install <root_path>` to add an explicit plugin root, or create a plugin under `.swarm/plugins`.");
  } else {
    for (const plugin of plugins) {
      lines.push(formatPluginSummaryLine(plugin));
      if (plugin.diagnostics.length) {
        lines.push(`  diagnostics=${plugin.diagnostics.length}`);
      }
    }
    lines.push("");
    lines.push("Use `swarm plugins show <plugin_id>` for manifest details or `swarm plugins validate` for diagnostics.");
  }
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      settings,
      summary: {
        ...summary,
        totals: {
          ...summary.totals,
          disabled: totals.disabled,
          untrusted: totals.untrusted
        }
      },
      plugins
    }
  };
}

export async function buildPluginDetailReport(runtime: SwarmRuntime, selector?: string): Promise<PluginCliReport> {
  const resolution = resolvePluginSelector(runtime, selector);
  if (!resolution.pluginId) {
    throw new Error(resolution.error ?? `Unknown plugin: ${selector ?? "(missing)"}`);
  }
  const plugin = runtime.listPlugins().find((item) => item.id === resolution.pluginId);
  if (!plugin) {
    throw new Error(`Unknown plugin: ${resolution.pluginId}`);
  }
  const capabilities = await runtime.listCapabilities({
    providerId: `plugin:${plugin.id}`,
    includeDisabled: true
  });
  const diagnostics = collectPluginDiagnostics(plugin);
  const settings = pluginSettingsSnapshot(runtime);
  const lines = [
    "Swarm Plugin",
    `workspace=${runtime.getWorkspacePath()}`,
    `plugin=${plugin.id} scope=${plugin.scope} trust=${plugin.trust} version=${plugin.version ?? "(none)"} contributions=${plugin.contributions.length} capabilities=${capabilities.length}`,
    `path=${plugin.path}`,
    `directory=${plugin.directory}`,
    ""
  ];
  lines.push("Description");
  lines.push(plugin.description);
  lines.push("");
  lines.push("Contributions");
  if (!plugin.contributions.length) {
    lines.push("  (none)");
  } else {
    for (const contribution of plugin.contributions) {
      lines.push(`  ${contribution.kind}:${contribution.id} [${contribution.riskClass}] ${contribution.title}`);
      const usage = stringMetadata(contribution.metadata.usage);
      const path = stringMetadata(contribution.metadata.path);
      if (usage) {
        lines.push(`    usage=${usage}`);
      }
      if (path) {
        lines.push(`    path=${path}`);
      }
      lines.push(`    ${truncateText(contribution.description, 140)}`);
    }
  }
  lines.push("");
  lines.push("Capabilities");
  if (!capabilities.length) {
    lines.push("  (none)");
  } else {
    for (const capability of capabilities) {
      lines.push(`  ${capability.id} [${capability.kind}/${capability.status}/${capability.trust}] model_visible=${capability.modelVisible ? "yes" : "no"}`);
    }
  }
  if (diagnostics.length) {
    lines.push("");
    lines.push("Diagnostics");
    for (const diagnostic of diagnostics) {
      lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.contribution ? `${diagnostic.contribution} ` : ""}${diagnostic.code ?? "diagnostic"} ${diagnostic.message}`);
    }
  }
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      settings,
      plugin,
      capabilities,
      diagnostics
    }
  };
}

export function buildPluginValidationReport(runtime: SwarmRuntime, selector?: string): PluginCliReport {
  const settings = pluginSettingsSnapshot(runtime);
  const selected = selector
    ? [requirePlugin(runtime, selector)]
    : runtime.listPlugins();
  const diagnostics = selected.flatMap((plugin) => collectPluginDiagnostics(plugin));
  const failures = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warn").length;
  const lines = [
    "Swarm Plugin Validation",
    `workspace=${runtime.getWorkspacePath()}`,
    `settings enabled=${settings.enabled ? "yes" : "no"} load_project=${settings.load_project_plugins} configured_roots=${settings.configured_roots.length} disabled_ids=${settings.disabled.length}`,
    `summary plugins=${selected.length} errors=${failures} warnings=${warnings}`,
    ""
  ];
  if (!selected.length) {
    lines.push("No plugins discovered.");
  } else {
    for (const plugin of selected) {
      const pluginDiagnostics = collectPluginDiagnostics(plugin);
      const status = pluginDiagnostics.some((item) => item.severity === "error")
        ? "FAIL"
        : pluginDiagnostics.some((item) => item.severity === "warn")
          ? "WARN"
          : "OK";
      lines.push(`${status} ${plugin.id} [${plugin.scope}/${plugin.trust}] contributions=${plugin.contributions.length}`);
      if (!pluginDiagnostics.length) {
        lines.push("  clean");
      } else {
        for (const diagnostic of pluginDiagnostics) {
          lines.push(`  ${diagnostic.severity} ${diagnostic.contribution ? `${diagnostic.contribution} ` : ""}${diagnostic.code ?? "diagnostic"} ${diagnostic.message}`);
        }
      }
    }
  }
  if (!settings.enabled) {
    lines.push("");
    lines.push("WARN Plugins are disabled in settings.extensions.plugins.enabled.");
  }
  return {
    detail: lines.join("\n"),
    data: {
      workspace: runtime.getWorkspacePath(),
      settings,
      ok: failures === 0,
      failures,
      warnings,
      plugins: selected.map((plugin) => ({
        plugin,
        diagnostics: collectPluginDiagnostics(plugin)
      }))
    },
    ok: failures === 0,
    failures,
    warnings
  };
}

export function resolvePluginSelector(runtime: SwarmRuntime, query?: string): PluginSelectorResolution {
  const trimmed = query?.trim();
  const plugins = runtime.listPlugins();
  if (!trimmed) {
    return { error: "Plugin id is required." };
  }
  const exact = plugins.find((plugin) => plugin.id === trimmed);
  if (exact) {
    return { pluginId: exact.id };
  }
  const normalized = trimmed.toLowerCase();
  const exactInsensitive = plugins.find((plugin) => plugin.id.toLowerCase() === normalized);
  if (exactInsensitive) {
    return { pluginId: exactInsensitive.id };
  }
  const prefixMatches = plugins.filter((plugin) => plugin.id.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) {
    return { pluginId: prefixMatches[0].id };
  }
  if (prefixMatches.length > 1) {
    return {
      error: `Ambiguous plugin selector: ${trimmed}. Matches: ${prefixMatches.slice(0, 6).map((plugin) => plugin.id).join(", ")}`
    };
  }
  const fuzzyMatches = plugins.filter((plugin) =>
    plugin.id.toLowerCase().includes(normalized) || plugin.name.toLowerCase().includes(normalized)
  );
  if (fuzzyMatches.length === 1) {
    return { pluginId: fuzzyMatches[0].id };
  }
  if (fuzzyMatches.length > 1) {
    return {
      error: `Ambiguous plugin selector: ${trimmed}. Matches: ${fuzzyMatches.slice(0, 6).map((plugin) => plugin.id).join(", ")}`
    };
  }
  return { error: `Unknown plugin: ${trimmed}` };
}

function requirePlugin(runtime: SwarmRuntime, selector: string): PluginRecord {
  const resolution = resolvePluginSelector(runtime, selector);
  if (!resolution.pluginId) {
    throw new Error(resolution.error ?? `Unknown plugin: ${selector}`);
  }
  const plugin = runtime.listPlugins().find((item) => item.id === resolution.pluginId);
  if (!plugin) {
    throw new Error(`Unknown plugin: ${resolution.pluginId}`);
  }
  return plugin;
}

function pluginSettingsSnapshot(runtime: SwarmRuntime): {
  enabled: boolean;
  load_project_plugins: string;
  configured_roots: string[];
  disabled: string[];
  max_plugins: number;
} {
  return {
    enabled: runtime.settings.extensions.plugins.enabled,
    load_project_plugins: runtime.settings.extensions.plugins.loadProjectPlugins,
    configured_roots: [...runtime.settings.extensions.plugins.roots],
    disabled: [...runtime.settings.extensions.plugins.disabled],
    max_plugins: runtime.settings.extensions.plugins.maxPlugins
  };
}

function pluginTotals(plugins: PluginRecord[]): {
  disabled: number;
  untrusted: number;
} {
  return {
    disabled: plugins.filter((plugin) => plugin.trust === "disabled").length,
    untrusted: plugins.filter((plugin) => plugin.trust === "untrusted").length
  };
}

function formatPluginSummaryLine(plugin: PluginRecord): string {
  return [
    `${plugin.id} [${plugin.scope}/${plugin.trust}]${plugin.version ? ` v${plugin.version}` : ""}`,
    `contributions=${plugin.contributions.length}`,
    truncateText(plugin.description, 88)
  ].join(" ");
}

function collectPluginDiagnostics(plugin: PluginRecord): PluginDiagnosticRecord[] {
  const diagnostics: PluginDiagnosticRecord[] = plugin.diagnostics.map((diagnostic) => ({
    plugin_id: plugin.id,
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message
  }));
  if (plugin.trust === "disabled") {
    diagnostics.push({
      plugin_id: plugin.id,
      severity: "warn",
      code: "PLUGIN_DISABLED",
      message: "Plugin is present but disabled by settings.extensions.plugins.disabled."
    });
  } else if (plugin.trust === "untrusted") {
    diagnostics.push({
      plugin_id: plugin.id,
      severity: "warn",
      code: "PLUGIN_UNTRUSTED",
      message: "Plugin was discovered from an untrusted project root and is not active."
    });
  }
  for (const contribution of plugin.contributions) {
    const contributionDiagnostics = Array.isArray(contribution.metadata.diagnostics)
      ? contribution.metadata.diagnostics.filter(isCapabilityDiagnostic)
      : [];
    for (const diagnostic of contributionDiagnostics) {
      diagnostics.push({
        plugin_id: plugin.id,
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        contribution: `${contribution.kind}:${contribution.id}`
      });
    }
  }
  return diagnostics;
}

function isCapabilityDiagnostic(value: unknown): value is CapabilityDiagnostic {
  return typeof value === "object"
    && value !== null
    && typeof (value as { severity?: unknown }).severity === "string"
    && typeof (value as { message?: unknown }).message === "string";
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length ? value : undefined;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
