import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SwarmSettings = {
  version: 1;
  models: {
    defaultProvider: string;
    planner: string;
    worker: string;
    aggregator: string;
    // Legacy fields are still read during migration.
    provider?: string;
    apiKeyEnv: string;
    openaiBaseUrl?: string;
  };
  providers: Record<string, ProviderDefinition>;
  enabledProviders: string[];
  disabledProviders: string[];
  runtime: {
    maxAgents: number;
    maxParallelTasks: number;
    taskTimeoutMs: number;
    databasePath: string;
    projectArtifactDir: string;
  };
  tools: {
    webSearch: boolean;
    directWrite: boolean;
  };
  permissions: {
    defaultMode: PermissionMode | "planThenExecute" | "auto";
    allow: string[];
    ask: string[];
    deny: string[];
    additionalDirectories: string[];
  };
  ui: {
    theme: "default";
  };
  telemetry: {
    enabled: boolean;
  };
};

export type PermissionMode = "ask" | "auto-edit" | "full-auto" | "yolo";

export type ProviderProtocol =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "google-gemini";

export type ModelListProtocol = "openai" | "anthropic" | "none";

export type ProviderModelInfo = {
  name: string;
  default?: boolean;
  small?: boolean;
  discovered?: boolean;
};

export type ProviderDefinition = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  modelListProtocol?: ModelListProtocol;
  modelListURL?: string;
  apiKeyEnv: string;
  apiKeyRequired: boolean;
  auth: "bearer" | "x-api-key" | "query-key" | "none";
  headers?: Record<string, string>;
  custom?: boolean;
  models: Record<string, ProviderModelInfo>;
  discoveredModels?: Record<string, ProviderModelInfo>;
  lastModelDiscoveryError?: string;
  lastModelDiscoveryAt?: string;
};

export type SwarmConfig = {
  version: 1;
  created_at: string;
  primaryProvider: string;
  primaryApiKey: string;
  providerApiKeys: Record<string, string>;
  modelProviderApiKeys: {
    openai: string;
  };
  note: string;
};

export type ProviderReadiness = {
  providerId: string;
  modelRef: string;
  configured: boolean;
  reason?: string;
};

export type SwarmPaths = {
  home: string;
  settingsPath: string;
  configPath: string;
  stateDir: string;
  sessionsDir: string;
  artifactsDir: string;
  logsDir: string;
  cacheDir: string;
  agentsDir: string;
  commandsDir: string;
  pluginsDir: string;
  projectsDir: string;
};

export function getSwarmPaths(): SwarmPaths {
  const home = resolve(process.env.SWARM_HOME ?? join(homedir(), ".swarm"));
  return {
    home,
    settingsPath: join(home, "settings.json"),
    configPath: join(home, "config.json"),
    stateDir: join(home, "state"),
    sessionsDir: join(home, "sessions"),
    artifactsDir: join(home, "artifacts"),
    logsDir: join(home, "logs"),
    cacheDir: join(home, "cache"),
    agentsDir: join(home, "agents"),
    commandsDir: join(home, "commands"),
    pluginsDir: join(home, "plugins"),
    projectsDir: join(home, "projects")
  };
}

export function defaultSwarmSettings(paths = getSwarmPaths()): SwarmSettings {
  return {
    version: 1,
    models: {
      defaultProvider: "",
      planner: "",
      worker: "",
      aggregator: "",
      apiKeyEnv: ""
    },
    providers: defaultProviderRegistry(),
    enabledProviders: [],
    disabledProviders: [],
    runtime: {
      maxAgents: 8,
      maxParallelTasks: 3,
      taskTimeoutMs: 120_000,
      databasePath: join(paths.stateDir, "swarm.db"),
      projectArtifactDir: ".swarm/artifacts"
    },
    tools: {
      webSearch: true,
      directWrite: true
    },
    permissions: {
      defaultMode: "ask",
      allow: ["Read(**)", "LS(**)", "Grep(**)", "Glob(**)", "Stat(**)", "WebSearch(*)"],
      ask: [
        "Write(**)",
        "Edit(**)",
        "Bash(*)",
        "WebFetch(*)",
        "CodeTest(*)",
        "CodeLint(*)",
        "GitBranch(*)",
        "PackageInstall(*)",
        "SolidityCompile(*)",
        "Delegate(*)"
      ],
      deny: [
        "Read(.env)",
        "Read(.env.*)",
        "Read(secrets/**)",
        "Read(config/credentials.json)",
        "Read(**/.swarm/config.json)"
      ],
      additionalDirectories: []
    },
    ui: {
      theme: "default"
    },
    telemetry: {
      enabled: false
    }
  };
}

export function ensureSwarmHome(): { paths: SwarmPaths; settings: SwarmSettings; created: string[] } {
  const paths = getSwarmPaths();
  const created: string[] = [];
  for (const dir of [
    paths.home,
    paths.stateDir,
    paths.sessionsDir,
    paths.artifactsDir,
    paths.logsDir,
    paths.cacheDir,
    paths.agentsDir,
    paths.commandsDir,
    paths.pluginsDir,
    paths.projectsDir
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  if (!existsSync(paths.settingsPath)) {
    writeJson(paths.settingsPath, defaultSwarmSettings(paths));
    created.push(paths.settingsPath);
  } else {
    writeJson(paths.settingsPath, loadUserSwarmSettings(paths));
  }

  if (!existsSync(paths.configPath)) {
    writeJson(paths.configPath, defaultSwarmConfig());
    created.push(paths.configPath);
  } else {
    saveSwarmConfig(loadSwarmConfig());
  }

  const readmePath = join(paths.home, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(
      readmePath,
      [
        "# Swarm home",
        "",
        "This directory stores user-level Swarm CLI configuration and runtime state.",
        "",
        "- `settings.json`: global settings, model defaults, permissions, tool behavior",
        "- `config.json`: local metadata and plaintext API keys",
        "- `state/`: SQLite state databases",
        "- `sessions/`: future transcript/session files",
        "- `agents/`, `commands/`, `plugins/`: future extension points",
        "",
        "Project-specific artifacts are written under the workspace `.swarm/` directory by default."
      ].join("\n"),
      "utf8"
    );
    created.push(readmePath);
  }

  return { paths, settings: loadSwarmSettings(), created };
}

export function defaultSwarmConfig(): SwarmConfig {
  return {
    version: 1,
    created_at: new Date().toISOString(),
    primaryProvider: "",
    primaryApiKey: "",
    providerApiKeys: Object.fromEntries(Object.keys(defaultProviderRegistry()).map((provider) => [provider, ""])),
    modelProviderApiKeys: {
      openai: ""
    },
    note: "Local Swarm metadata. API keys are stored in plaintext by design for this local CLI."
  };
}

export function loadSwarmConfig(): SwarmConfig {
  const paths = getSwarmPaths();
  const raw = readJsonIfExists(paths.configPath);
  const config = deepMerge(defaultSwarmConfig(), raw) as SwarmConfig;
  config.providerApiKeys = {
    ...Object.fromEntries(Object.keys(defaultProviderRegistry()).map((provider) => [provider, ""])),
    ...config.providerApiKeys,
    openai: config.providerApiKeys.openai || config.modelProviderApiKeys.openai
  };
  if (config.note.includes("Keep secrets in environment variables")) {
    config.note = defaultSwarmConfig().note;
  }
  return config;
}

export function saveSwarmConfig(config: SwarmConfig): void {
  writeJson(getSwarmPaths().configPath, config);
}

export function setPrimaryApiKey(apiKey: string): void {
  const config = loadSwarmConfig();
  const provider = config.primaryProvider;
  if (!provider) {
    throw new Error("No primary provider selected. Pass a provider id explicitly.");
  }
  saveSwarmConfig({
    ...config,
    primaryApiKey: apiKey,
    providerApiKeys: {
      ...config.providerApiKeys,
      [provider]: apiKey
    },
    modelProviderApiKeys: {
      ...config.modelProviderApiKeys,
      openai: provider === "openai" ? apiKey : config.modelProviderApiKeys.openai
    }
  });
}

export function setProviderApiKey(provider: string, apiKey: string): void {
  const config = loadSwarmConfig();
  saveSwarmConfig({
    ...config,
    primaryProvider: provider,
    primaryApiKey: apiKey,
    providerApiKeys: {
      ...config.providerApiKeys,
      [provider]: apiKey
    },
    modelProviderApiKeys: {
      ...config.modelProviderApiKeys,
      openai: provider === "openai" ? apiKey : config.modelProviderApiKeys.openai
    }
  });
}

export function addCustomProvider(input: {
  id: string;
  name: string;
  baseURL: string;
  model?: string;
  apiKey?: string;
  apiKeyRequired?: boolean;
  protocol?: "openai-chat-completions" | "anthropic-messages";
  auth?: "bearer" | "x-api-key" | "none";
  modelListURL?: string;
}): void {
  const providerId = normalizeProviderId(input.id);
  if (!providerId) {
    throw new Error("Provider id is required");
  }

  const settings = loadSwarmSettings();
  const protocol = input.protocol ?? "openai-chat-completions";
  const baseURL =
    protocol === "anthropic-messages"
      ? normalizeClaudeMessagesURL(input.baseURL)
      : input.baseURL.trim().replace(/\/$/, "");
  const model = input.model?.trim();
  const provider: ProviderDefinition = {
    id: providerId,
    name: input.name.trim() || providerId,
    protocol,
    baseURL,
    modelListProtocol: protocol === "anthropic-messages" ? "anthropic" : "openai",
    modelListURL: input.modelListURL?.trim() || deriveModelListURL(protocol, baseURL),
    apiKeyEnv: `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`,
    apiKeyRequired: input.apiKeyRequired ?? Boolean(input.apiKey?.trim()),
    auth: input.auth ?? (protocol === "anthropic-messages" ? "x-api-key" : input.apiKey?.trim() ? "bearer" : "none"),
    custom: true,
    models: model ? { [model]: { name: model, default: true } } : {},
    discoveredModels: {}
  };

  saveSwarmSettings({
    ...settings,
    providers: {
      ...settings.providers,
      [providerId]: provider
    }
  });

  if (input.apiKey?.trim()) {
    setProviderApiKey(providerId, input.apiKey.trim());
  }
}

export function updateProviderModels(input: {
  providerId: string;
  models: string[];
  discovered?: boolean;
  error?: string;
}): void {
  const settings = loadSwarmSettings();
  const provider = settings.providers[input.providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${input.providerId}`);
  }

  const modelMap = Object.fromEntries(
    input.models.map((model) => [
      model,
      {
        name: model,
        discovered: input.discovered ?? true
      } satisfies ProviderModelInfo
    ])
  );

  saveSwarmSettings({
    ...settings,
    providers: {
      ...settings.providers,
      [input.providerId]: {
        ...provider,
        models: {
          ...provider.models,
          ...modelMap
        },
        discoveredModels: {
          ...(provider.discoveredModels ?? {}),
          ...modelMap
        },
        lastModelDiscoveryAt: new Date().toISOString(),
        lastModelDiscoveryError: input.error
      }
    }
  });
}

export function setModelSelection(input: {
  defaultProvider?: string;
  planner?: string;
  worker?: string;
  aggregator?: string;
}): void {
  const settings = loadSwarmSettings();
  const inferredProvider = input.planner?.includes("/") ? input.planner.split("/")[0] : undefined;
  const defaultProvider = input.defaultProvider ?? inferredProvider ?? settings.models.defaultProvider;
  saveSwarmSettings({
    ...settings,
    models: {
      ...settings.models,
      defaultProvider,
      planner: input.planner ? normalizeModelRef(input.planner, defaultProvider) : settings.models.planner,
      worker: input.worker ? normalizeModelRef(input.worker, defaultProvider) : settings.models.worker,
      aggregator: input.aggregator ? normalizeModelRef(input.aggregator, defaultProvider) : settings.models.aggregator
    }
  });
}

export function setPermissionMode(mode: PermissionMode): void {
  const settings = loadSwarmSettings();
  saveSwarmSettings({
    ...settings,
    permissions: {
      ...settings.permissions,
      defaultMode: mode
    }
  });
}

export function saveSwarmSettings(settings: SwarmSettings): void {
  const paths = getSwarmPaths();
  writeJson(paths.settingsPath, normalizeSwarmSettings(expandSettings(settings)));
}

export function loadSwarmSettings(workspace = process.cwd()): SwarmSettings {
  const paths = getSwarmPaths();
  const defaults = defaultSwarmSettings(paths);
  const userSettings = readJsonIfExists(paths.settingsPath);
  const projectSettings = readJsonIfExists(resolve(workspace, ".swarm", "settings.json"));
  const localSettings = readJsonIfExists(resolve(workspace, ".swarm", "settings.local.json"));
  const merged = deepMerge(defaults, userSettings, projectSettings, localSettings) as SwarmSettings;
  return normalizeSwarmSettings(expandSettings(merged));
}

export function listEnabledProviders(settings = loadSwarmSettings()): ProviderDefinition[] {
  const disabled = new Set(settings.disabledProviders);
  const enabled = new Set(settings.enabledProviders);
  return Object.values(settings.providers).filter((provider) => {
    if (disabled.has(provider.id)) {
      return false;
    }
    return enabled.size === 0 || enabled.has(provider.id);
  });
}

export function resolveModelRef(
  modelRef: string,
  settings = loadSwarmSettings()
): { providerId: string; model: string; provider?: ProviderDefinition } {
  const trimmed = modelRef.trim();
  if (!trimmed) {
    return { providerId: "", model: "", provider: undefined };
  }
  const [providerId, ...modelParts] = trimmed.includes("/")
    ? trimmed.split("/")
    : [settings.models.defaultProvider.trim(), trimmed];
  const model = modelParts.join("/");
  return {
    providerId,
    model,
    provider: settings.providers[providerId]
  };
}

export function getProviderModels(provider: ProviderDefinition): string[] {
  return [...new Set([...Object.keys(provider.models), ...Object.keys(provider.discoveredModels ?? {})])].sort();
}

export function getProviderApiKey(provider: ProviderDefinition, config = loadSwarmConfig()): string {
  return config.providerApiKeys[provider.id] || process.env[provider.apiKeyEnv] || "";
}

export function getModelReadiness(
  modelRef: string,
  settings = loadSwarmSettings(),
  config = loadSwarmConfig()
): ProviderReadiness {
  if (!modelRef.trim()) {
    return {
      providerId: "",
      modelRef: "",
      configured: false,
      reason: "No model selected"
    };
  }

  const resolved = resolveModelRef(modelRef, settings);
  if (!resolved.providerId) {
    return {
      providerId: "",
      modelRef,
      configured: false,
      reason: `No provider selected for model "${resolved.model}"`
    };
  }

  if (!resolved.provider) {
    return {
      providerId: resolved.providerId,
      modelRef,
      configured: false,
      reason: `Unknown provider "${resolved.providerId}"`
    };
  }

  if (!resolved.provider.apiKeyRequired) {
    return {
      providerId: resolved.providerId,
      modelRef,
      configured: true
    };
  }

  const apiKey = getProviderApiKey(resolved.provider, config);
  return {
    providerId: resolved.providerId,
    modelRef,
    configured: Boolean(apiKey),
    reason: apiKey ? undefined : `Missing API key for provider "${resolved.providerId}"`
  };
}

export function getSelectedModelReadiness(
  settings = loadSwarmSettings(),
  config = loadSwarmConfig()
): ProviderReadiness[] {
  const entries = [
    ["planner", settings.models.planner],
    ["worker", settings.models.worker],
    ["aggregator", settings.models.aggregator]
  ] as const;

  return entries.map(([role, modelRef]) => {
    if (!modelRef.trim()) {
      return {
        providerId: "",
        modelRef: role,
        configured: false,
        reason: `${role[0].toUpperCase()}${role.slice(1)} model not set`
      };
    }
    return getModelReadiness(modelRef, settings, config);
  });
}

export function hasUsableModelConfiguration(settings = loadSwarmSettings(), config = loadSwarmConfig()): boolean {
  return getSelectedModelReadiness(settings, config).every((readiness) => readiness.configured);
}

function loadUserSwarmSettings(paths: SwarmPaths): SwarmSettings {
  const defaults = defaultSwarmSettings(paths);
  const userSettings = readJsonIfExists(paths.settingsPath);
  return normalizeSwarmSettings(expandSettings(deepMerge(defaults, userSettings) as SwarmSettings));
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function deepMerge(...values: unknown[]): unknown {
  const result: Record<string, unknown> = {};
  for (const value of values) {
    if (!isObject(value)) {
      continue;
    }
    for (const [key, next] of Object.entries(value)) {
      const previous = result[key];
      result[key] = isObject(previous) && isObject(next) ? deepMerge(previous, next) : next;
    }
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandSettings(settings: SwarmSettings): SwarmSettings {
  return {
    ...settings,
    runtime: {
      ...settings.runtime,
      databasePath: expandPath(settings.runtime.databasePath)
    },
    models: {
      ...settings.models,
      openaiBaseUrl: settings.models.openaiBaseUrl ? expandEnv(settings.models.openaiBaseUrl) : undefined
    }
  };
}

function normalizeSwarmSettings(settings: SwarmSettings): SwarmSettings {
  const legacyProvider = settings.models.provider?.trim() ?? "";
  const defaultProvider = settings.models.defaultProvider?.trim() || legacyProvider;
  const permissions = normalizePermissions(settings.permissions);
  return {
    ...settings,
    models: {
      ...settings.models,
      defaultProvider,
      planner: normalizeModelRef(settings.models.planner, defaultProvider),
      worker: normalizeModelRef(settings.models.worker, defaultProvider),
      aggregator: normalizeModelRef(settings.models.aggregator, defaultProvider)
    },
    permissions,
    providers: normalizeProviderRegistry(settings.providers),
    enabledProviders: Array.isArray(settings.enabledProviders) ? settings.enabledProviders : [],
    disabledProviders: Array.isArray(settings.disabledProviders) ? settings.disabledProviders : []
  };
}

function normalizePermissions(permissions: SwarmSettings["permissions"]): SwarmSettings["permissions"] {
  const envMode = process.env.SWARM_PERMISSION_MODE;
  const defaultMode =
    envMode === "yolo" || permissions.defaultMode === "yolo"
      ? "yolo"
      : envMode === "full-auto" || permissions.defaultMode === "full-auto" || permissions.defaultMode === "auto"
      ? "full-auto"
      : envMode === "auto-edit" || permissions.defaultMode === "auto-edit"
        ? "auto-edit"
        : "ask";
  return {
    defaultMode,
    allow: Array.isArray(permissions.allow) ? permissions.allow : [],
    ask: Array.isArray(permissions.ask) ? permissions.ask : ["Write(**)", "Edit(**)", "Bash(*)"],
    deny: Array.isArray(permissions.deny) ? permissions.deny : [],
    additionalDirectories: Array.isArray(permissions.additionalDirectories) ? permissions.additionalDirectories : []
  };
}

function normalizeModelRef(model: string, defaultProvider: string): string {
  const trimmed = model?.trim() ?? "";
  if (!trimmed || trimmed.includes("/") || !defaultProvider.trim()) {
    return trimmed;
  }
  return `${defaultProvider}/${trimmed}`;
}

function normalizeProviderRegistry(providers: Record<string, ProviderDefinition>): Record<string, ProviderDefinition> {
  const defaults = defaultProviderRegistry();
  const merged = deepMerge(defaults, providers) as Record<string, ProviderDefinition>;
  return Object.fromEntries(
    Object.entries(merged).map(([id, provider]) => [
      id,
      {
        ...provider,
        id,
        modelListProtocol: provider.modelListProtocol ?? defaultModelListProtocol(provider.protocol),
        modelListURL: provider.modelListURL ?? deriveModelListURL(provider.protocol, provider.baseURL),
        discoveredModels: provider.discoveredModels ?? {}
      }
    ])
  );
}

function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function expandPath(path: string): string {
  const expanded = expandEnv(path);
  if (expanded === "~") {
    return homedir();
  }
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    return resolve(homedir(), expanded.slice(2));
  }
  return resolve(expanded);
}

function expandEnv(value: string): string {
  return value.replace(/\$\{?([A-Z0-9_]+)\}?/gi, (_, name: string) => process.env[name] ?? "");
}

function defaultModelListProtocol(protocol: ProviderProtocol): ModelListProtocol {
  if (protocol === "anthropic-messages") {
    return "anthropic";
  }
  if (protocol === "google-gemini") {
    return "none";
  }
  return "openai";
}

function deriveModelListURL(protocol: ProviderProtocol, baseURL: string): string | undefined {
  const normalized = baseURL.trim().replace(/\/$/, "");
  if (protocol === "anthropic-messages") {
    return normalized.endsWith("/messages") ? normalized.slice(0, -"/messages".length) + "/models" : `${normalized}/models`;
  }
  if (protocol === "google-gemini") {
    return undefined;
  }
  return `${normalized}/models`;
}

function normalizeClaudeMessagesURL(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/$/, "");
  return normalized.endsWith("/messages") ? normalized : `${normalized}/messages`;
}

export function defaultProviderRegistry(): Record<string, ProviderDefinition> {
  return {
    openai: {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.openai.com/v1/models",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "gpt-5.5": { name: "GPT-5.5", default: true },
        "gpt-5.4": { name: "GPT-5.4" },
        "gpt-5.4-mini": { name: "GPT-5.4 Mini", small: true }
      }
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      protocol: "anthropic-messages",
      baseURL: "https://api.anthropic.com/v1/messages",
      modelListProtocol: "anthropic",
      modelListURL: "https://api.anthropic.com/v1/models",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      apiKeyRequired: true,
      auth: "x-api-key",
      headers: { "anthropic-version": "2023-06-01" },
      models: {
        "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", default: true },
        "claude-haiku-4-5": { name: "Claude Haiku 4.5", small: true }
      }
    },
    gemini: {
      id: "gemini",
      name: "Google Gemini",
      protocol: "google-gemini",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      modelListProtocol: "none",
      apiKeyEnv: "GEMINI_API_KEY",
      apiKeyRequired: true,
      auth: "query-key",
      models: {
        "gemini-2.5-pro": { name: "Gemini 2.5 Pro", default: true },
        "gemini-2.5-flash": { name: "Gemini 2.5 Flash", small: true }
      }
    },
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      protocol: "openai-chat-completions",
      baseURL: "https://openrouter.ai/api/v1",
      modelListProtocol: "openai",
      modelListURL: "https://openrouter.ai/api/v1/models",
      apiKeyEnv: "OPENROUTER_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "anthropic/claude-sonnet-4.5": { name: "Claude Sonnet 4.5" },
        "openai/gpt-5.1": { name: "GPT-5.1" },
        "google/gemini-2.5-pro": { name: "Gemini 2.5 Pro" }
      }
    },
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      protocol: "openai-chat-completions",
      baseURL: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "deepseek-chat": { name: "DeepSeek Chat", default: true },
        "deepseek-reasoner": { name: "DeepSeek Reasoner" }
      }
    },
    xai: {
      id: "xai",
      name: "xAI",
      protocol: "openai-chat-completions",
      baseURL: "https://api.x.ai/v1",
      apiKeyEnv: "XAI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "grok-code-fast-1": { name: "Grok Code Fast 1", default: true },
        "grok-4": { name: "Grok 4" }
      }
    },
    groq: {
      id: "groq",
      name: "Groq",
      protocol: "openai-chat-completions",
      baseURL: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "qwen/qwen3-coder-480b-a35b-instruct": { name: "Qwen3 Coder 480B", default: true },
        "llama-3.3-70b-versatile": { name: "Llama 3.3 70B Versatile" }
      }
    },
    cerebras: {
      id: "cerebras",
      name: "Cerebras",
      protocol: "openai-chat-completions",
      baseURL: "https://api.cerebras.ai/v1",
      apiKeyEnv: "CEREBRAS_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "qwen-3-coder-480b": { name: "Qwen 3 Coder 480B", default: true },
        "llama3.1-8b": { name: "Llama 3.1 8B" }
      }
    },
    together: {
      id: "together",
      name: "Together AI",
      protocol: "openai-chat-completions",
      baseURL: "https://api.together.xyz/v1",
      apiKeyEnv: "TOGETHER_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": { name: "Qwen3 Coder 480B", default: true },
        "meta-llama/Llama-3.3-70B-Instruct-Turbo": { name: "Llama 3.3 70B Turbo" }
      }
    },
    fireworks: {
      id: "fireworks",
      name: "Fireworks AI",
      protocol: "openai-chat-completions",
      baseURL: "https://api.fireworks.ai/inference/v1",
      apiKeyEnv: "FIREWORKS_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct": { name: "Qwen3 Coder 480B", default: true },
        "accounts/fireworks/models/llama-v3p3-70b-instruct": { name: "Llama 3.3 70B" }
      }
    },
    moonshot: {
      id: "moonshot",
      name: "Moonshot AI",
      protocol: "openai-chat-completions",
      baseURL: "https://api.moonshot.ai/v1",
      apiKeyEnv: "MOONSHOT_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "kimi-k2-0711-preview": { name: "Kimi K2", default: true },
        "moonshot-v1-128k": { name: "Moonshot v1 128K" }
      }
    },
    "kimi-coding": {
      id: "kimi-coding",
      name: "Kimi Coding Plan",
      protocol: "openai-chat-completions",
      baseURL: "https://api.kimi.com/coding/v1",
      modelListProtocol: "openai",
      modelListURL: "https://api.kimi.com/coding/v1/models",
      apiKeyEnv: "KIMI_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "kimi-for-coding": { name: "kimi-for-coding", default: true }
      }
    },
    mistral: {
      id: "mistral",
      name: "Mistral AI",
      protocol: "openai-chat-completions",
      baseURL: "https://api.mistral.ai/v1",
      apiKeyEnv: "MISTRAL_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "codestral-latest": { name: "Codestral Latest", default: true },
        "mistral-large-latest": { name: "Mistral Large Latest" }
      }
    },
    siliconflow: {
      id: "siliconflow",
      name: "SiliconFlow",
      protocol: "openai-chat-completions",
      baseURL: "https://api.siliconflow.cn/v1",
      apiKeyEnv: "SILICONFLOW_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "Qwen/Qwen3-Coder-480B-A35B-Instruct": { name: "Qwen3 Coder 480B", default: true },
        "deepseek-ai/DeepSeek-V3": { name: "DeepSeek V3" }
      }
    },
    dashscope: {
      id: "dashscope",
      name: "Alibaba DashScope",
      protocol: "openai-chat-completions",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "DASHSCOPE_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {
        "qwen3-coder-plus": { name: "Qwen3 Coder Plus", default: true },
        "qwen-plus": { name: "Qwen Plus" }
      }
    },
    requesty: {
      id: "requesty",
      name: "Requesty",
      protocol: "openai-chat-completions",
      baseURL: "https://router.requesty.ai/v1",
      apiKeyEnv: "REQUESTY_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {}
    },
    helicone: {
      id: "helicone",
      name: "Helicone AI Gateway",
      protocol: "openai-chat-completions",
      baseURL: "https://ai-gateway.helicone.ai",
      apiKeyEnv: "HELICONE_API_KEY",
      apiKeyRequired: true,
      auth: "bearer",
      models: {}
    },
    ollama: {
      id: "ollama",
      name: "Ollama Local",
      protocol: "openai-chat-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "OLLAMA_API_KEY",
      apiKeyRequired: false,
      auth: "none",
      models: {
        "qwen2.5-coder:latest": { name: "Qwen 2.5 Coder Local", default: true },
        "llama3.3:latest": { name: "Llama 3.3 Local" }
      }
    },
    lmstudio: {
      id: "lmstudio",
      name: "LM Studio Local",
      protocol: "openai-chat-completions",
      baseURL: "http://127.0.0.1:1234/v1",
      apiKeyEnv: "LMSTUDIO_API_KEY",
      apiKeyRequired: false,
      auth: "none",
      models: {}
    },
    vllm: {
      id: "vllm",
      name: "vLLM Local",
      protocol: "openai-chat-completions",
      baseURL: "http://127.0.0.1:8000/v1",
      apiKeyEnv: "VLLM_API_KEY",
      apiKeyRequired: false,
      auth: "none",
      models: {}
    },
    localai: {
      id: "localai",
      name: "LocalAI",
      protocol: "openai-chat-completions",
      baseURL: "http://127.0.0.1:8080/v1",
      apiKeyEnv: "LOCALAI_API_KEY",
      apiKeyRequired: false,
      auth: "none",
      models: {}
    }
  };
}
