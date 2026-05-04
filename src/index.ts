#!/usr/bin/env node
process.removeAllListeners("warning");
const [, , rawCommand, ...rawArgs] = process.argv;
let command: string | undefined = rawCommand;
let args = rawArgs;

// If a flag was passed where a command is expected, treat it as an arg
const KNOWN_FLAGS = new Set(["--debug", "--verbose", "-v", "--debug-trace"]);
if (command && KNOWN_FLAGS.has(command)) {
  args = [command, ...args];
  command = undefined;
}

// Parse --debug / --verbose early so env is set before any imports
if (args.includes("--debug") || args.includes("--verbose") || args.includes("-v")) {
  process.env.SWARM_DEBUG = "true";
}
if (args.includes("--debug-trace")) {
  process.env.SWARM_DEBUG = "true";
  process.env.SWARM_DEBUG_LEVEL = "trace";
}

if (!command) {
  await launchChat();
} else if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "chat") {
  await launchChat();
} else if (command === "onboard") {
  await launchChat({ forceOnboarding: true });
} else if (command === "init") {
  const { ensureSwarmHome } = await import("./config/settings.js");
  const { paths, created } = ensureSwarmHome();
  console.log(`Swarm home: ${paths.home}`);
  if (created.length === 0) {
    console.log("Already initialized.");
  } else {
    console.log("Created:");
    for (const path of created) {
      console.log(`  ${path}`);
    }
  }
} else if (command === "config") {
  const subcommand = args[0];
  const { ensureSwarmHome } = await import("./config/settings.js");
  const { paths } = ensureSwarmHome();
  if (!subcommand || subcommand === "path") {
    const target = args[1] ?? "settings";
    console.log(target === "config" ? paths.configPath : paths.settingsPath);
  } else if (subcommand === "home") {
    console.log(paths.home);
  } else {
    console.error(`Unknown config command: ${subcommand}`);
    process.exitCode = 1;
  }
} else if (command === "auth") {
  const subcommand = args[0];
  const { ensureSwarmHome, loadSwarmConfig, loadSwarmSettings, setPrimaryApiKey, setProviderApiKey } = await import(
    "./config/settings.js"
  );
  const { paths } = ensureSwarmHome();
  if (subcommand === "set-key") {
    const maybeProvider = args[1];
    const maybeKey = args[2];
    const settings = loadSwarmSettings();
    const config = loadSwarmConfig();
    const provider = maybeKey ? maybeProvider : config.primaryProvider;
    const key = maybeKey ?? maybeProvider;
    if (!key) {
      console.error("Usage: swarm auth set-key [provider] <api-key>");
      process.exitCode = 1;
    } else if (!provider) {
      console.error("Provider is required because no primary provider is selected.");
      console.error("Usage: swarm auth set-key <provider> <api-key>");
      process.exitCode = 1;
    } else if (!settings.providers[provider]) {
      console.error(`Unknown provider: ${provider}`);
      process.exitCode = 1;
    } else {
      if (maybeKey) {
        setProviderApiKey(provider, key);
      } else {
        setPrimaryApiKey(key);
      }
      console.log(`Saved plaintext API key for ${provider} to ${paths.configPath}`);
    }
  } else if (!subcommand || subcommand === "status" || subcommand === "list") {
    const config = loadSwarmConfig();
    const settings = loadSwarmSettings();
    console.log(`Config: ${paths.configPath}`);
    console.log(`Primary provider: ${config.primaryProvider || "none selected"}`);
    for (const provider of Object.values(settings.providers)) {
      const key = config.providerApiKeys[provider.id] || process.env[provider.apiKeyEnv] || "";
      const source = config.providerApiKeys[provider.id] ? "plaintext" : process.env[provider.apiKeyEnv] ? "env" : "none";
      console.log(`${provider.id.padEnd(12)} ${key ? `configured (${source}, ${key.length} chars)` : "not configured"}`);
    }
  } else {
    console.error(`Unknown auth command: ${subcommand}`);
    process.exitCode = 1;
  }
} else if (command === "providers") {
  const { addCustomProvider, ensureSwarmHome, getProviderModels, loadSwarmSettings } = await import("./config/settings.js");
  ensureSwarmHome();
  const settings = loadSwarmSettings();
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    for (const provider of Object.values(settings.providers)) {
      const disabled = settings.disabledProviders.includes(provider.id) ? " disabled" : "";
      const models = Object.keys(provider.models).slice(0, 3).join(", ");
      console.log(`${provider.id.padEnd(12)} ${provider.protocol.padEnd(23)} ${provider.name}${disabled}`);
      if (models) {
        console.log(`             models: ${models}${Object.keys(provider.models).length > 3 ? ", ..." : ""}`);
      }
    }
  } else if (subcommand === "add" || subcommand === "add-openai" || subcommand === "add-claude") {
    const id = args[1];
    const options = parseOptions(args.slice(2));
    const isClaudeCompatible = subcommand === "add-claude";
    if (!id || !options.name || !options["base-url"]) {
      console.error(
        `Usage: swarm providers ${subcommand} <id> --name <name> --base-url <url> [--model <model>] [--api-key <key>]`
      );
      process.exitCode = 1;
    } else {
      addCustomProvider({
        id,
        name: options.name,
        baseURL: options["base-url"],
        model: options.model,
        apiKey: options["api-key"],
        protocol: isClaudeCompatible ? "anthropic-messages" : "openai-chat-completions",
        auth: isClaudeCompatible ? "x-api-key" : options["api-key"] ? "bearer" : "none",
        apiKeyRequired: isClaudeCompatible ? true : undefined
      });
      console.log(`Added custom ${isClaudeCompatible ? "Claude-compatible" : "OpenAI-compatible"} provider: ${id}`);
    }
  } else if (subcommand === "refresh") {
    const { refreshProviderModels } = await import("./providers/model-discovery.js");
    const providerIds = args[1] ? [args[1]] : Object.keys(settings.providers);
    for (const providerId of providerIds) {
      const result = await refreshProviderModels(providerId);
      if (result.error) {
        console.log(`${providerId}: ${result.error}`);
      } else {
        console.log(`${providerId}: discovered ${result.models.length} models`);
      }
    }
  } else if (subcommand === "models") {
    const providerId = args[1] ?? settings.models.defaultProvider;
    if (!providerId) {
      console.error("Provider is required because no default provider is selected.");
      process.exitCode = 1;
    } else {
      const provider = settings.providers[providerId];
      if (!provider) {
        console.error(`Unknown provider: ${providerId}`);
        process.exitCode = 1;
      } else {
        const models = getProviderModels(provider);
        if (provider.lastModelDiscoveryError) {
          console.log(`Last discovery error: ${provider.lastModelDiscoveryError}`);
        }
        for (const model of models) {
          console.log(model);
        }
      }
    }
  } else {
    const provider = settings.providers[subcommand];
    if (!provider) {
      console.error(`Unknown provider: ${subcommand}`);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(provider, null, 2));
    }
  }
} else if (command === "models") {
  const subcommand = args[0];
  const { ensureSwarmHome, loadSwarmSettings, setModelSelection } = await import("./config/settings.js");
  ensureSwarmHome();
  if (subcommand === "set") {
    const options = parseOptions(args.slice(1));
    setModelSelection({
      defaultProvider: options["default-provider"],
      planner: options.planner,
      worker: options.worker,
      aggregator: options.aggregator
    });
    console.log("Updated model selection.");
  } else if (!subcommand || subcommand === "show") {
    const settings = loadSwarmSettings();
    console.log(JSON.stringify(settings.models, null, 2));
  } else {
    console.error(`Unknown models command: ${subcommand}`);
    process.exitCode = 1;
  }
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function launchChat(options: { forceOnboarding?: boolean } = {}): Promise<void> {
  const [{ render }, React, { SwarmChatApp }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./tui/SwarmChatApp.js")
  ]);
  render(React.default.createElement(SwarmChatApp, options));
}

function parseOptions(values: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function printHelp(): void {
  const binary = process.platform === "win32" ? "swarm" : "swarm";
  console.log(`Agent Swarm Protocol CLI

Usage:
  ${binary} [--debug] [--debug-trace]
  ${binary} chat [--debug]
  ${binary} onboard
  ${binary} init
  ${binary} config path
  ${binary} auth set-key [provider] <api-key>
  ${binary} providers list
  ${binary} providers add-openai <id> --name <name> --base-url <url> [--model <model>] [--api-key <key>]
  ${binary} providers add-claude <id> --name <name> --base-url <url> [--model <model>] [--api-key <key>]
  ${binary} providers refresh [provider]
  ${binary} providers models <provider>
  ${binary} models set --planner <provider/model> --worker <provider/model> --aggregator <provider/model>

Commands:
  chat       Open the interactive swarm TUI (also the default)
  onboard    Configure provider, model, and plaintext API key
  init       Create ~/.swarm with user-level settings and state folders
  config     Print config paths
  auth       Manage plaintext API keys in ~/.swarm/config.json
  providers  List built-in model providers
  models     Show or update selected models

Debug:
  --debug, --verbose, -v    Write one JSONL log per chat session to ~/.swarm/logs/
  --debug-trace             Same but with trace-level detail (envelope payloads, etc.)
                            Logs roll to .part-N when a file exceeds 1MB

Environment:
  SWARM_HOME             Override the user-level ~/.swarm directory
  SWARM_DEBUG=1          Equivalent to --debug
  SWARM_DEBUG_SESSION_ID Override the debug log session filename stem
  OPENAI_API_KEY          Environment key source if no plaintext key is configured
  SWARM_MODEL             Override the configured planner model
  SWARM_WORKER_MODEL      Override the configured worker model
  SWARM_AGGREGATOR_MODEL  Override the configured aggregator model
`);
  if (args.length > 0) {
    console.log(`Ignored arguments: ${args.join(" ")}`);
  }
}
