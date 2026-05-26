import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultSwarmConfig, defaultSwarmSettings, getSwarmPaths } from "./config/settings.js";
import { summarizeMcpCatalog } from "./extensions/catalog-summary.js";
import { mcpSettingsSnapshot } from "./extensions/mcp-report.js";
import { skillSettingsSnapshot } from "./extensions/skill-report.js";
import { buildProviderProfiles, formatProviderProfiles } from "./providers/provider-profile.js";
import { loadSwarmVersion } from "./runtime/headless-artifacts.js";
import { SwarmRuntime } from "./runtime/runtime.js";
import { resolveTuiRendererMode } from "./tui/ui.js";

export type InstallSmokeStatus = "pass" | "fail";

export type InstallSmokeCheck = {
  id: string;
  status: InstallSmokeStatus;
  detail: string;
};

export type InstallSmokeResult = {
  schema_version: "swarm.install_smoke.v1";
  status: InstallSmokeStatus;
  version: string;
  cwd: string;
  package_root: string;
  swarm_home: string;
  checks: InstallSmokeCheck[];
};

export async function runInstallSmoke(input: { swarmHome?: string } = {}): Promise<InstallSmokeResult> {
  const previousHome = process.env.SWARM_HOME;
  const smokeHome = resolve(input.swarmHome ?? join(tmpdir(), `swarm-install-smoke-${process.pid}-${Date.now()}`));
  mkdirSync(smokeHome, { recursive: true });
  process.env.SWARM_HOME = smokeHome;
  writeSmokeConfig(smokeHome);

  const runtime = new SwarmRuntime({
    workspace: process.cwd(),
    databasePath: join(smokeHome, "state", "swarm.db")
  });
  const checks: InstallSmokeCheck[] = [];
  try {
    const paths = getSwarmPaths();
    checks.push(check("bin-entry", process.argv[1]?.length ? existsSync(resolve(process.argv[1])) : true, `entry=${process.argv[1] ?? "programmatic"}`));
    checks.push(check("version", /^\d+\.\d+\.\d+/.test(loadSwarmVersion()), `version=${loadSwarmVersion()}`));
    checks.push(check("default-renderer", resolveTuiRendererMode("legacy") === "dom-renderer", "legacy/auto inputs resolve to dom-renderer."));

    const skills = runtime.listSkills();
    const skillSummary = runtime.listSkills().length
      ? `${skills.length} skills: ${skills.slice(0, 5).map((skill) => skill.name).join(",")}`
      : "0 skills";
    checks.push(check("skills-default-catalog", skills.length >= 5 && skills.some((skill) => skill.name === "repo-auditor"), skillSummary));
    checks.push(check("skills-runtime-summary", skillSettingsSnapshot(runtime).enabled && skills.length > 0, "skills enabled with active catalog."));

    const mcpSummary = summarizeMcpCatalog(runtime.listMcpServers(), mcpSettingsSnapshot(runtime));
    checks.push(check("mcp-disabled-summary", mcpSummary.runtime?.state === "disabled", `state=${mcpSummary.runtime?.state ?? "missing"}`));

    const providerText = formatProviderProfiles(buildProviderProfiles({
      settings: runtime.settings,
      config: defaultSwarmConfig()
    })).join("\n");
    checks.push(check("provider-profile-redaction", !/sk-[A-Za-z0-9]/.test(providerText), "provider profile output does not include raw sk-* secrets."));

    checks.push(check("docs-links", docsExist(), "README and TUI renderer/product specs are present."));
  } finally {
    runtime.dispose();
    if (previousHome === undefined) {
      delete process.env.SWARM_HOME;
    } else {
      process.env.SWARM_HOME = previousHome;
    }
    if (!input.swarmHome) {
      rmSync(smokeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  const status = checks.every((item) => item.status === "pass") ? "pass" : "fail";
  return {
    schema_version: "swarm.install_smoke.v1",
    status,
    version: loadSwarmVersion(),
    cwd: process.cwd(),
    package_root: packageRoot(),
    swarm_home: smokeHome,
    checks
  };
}

function writeSmokeConfig(home: string): void {
  mkdirSync(join(home, "state"), { recursive: true });
  const settings = defaultSwarmSettings({
    ...getSwarmPaths(),
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
    skillsDir: join(home, "skills"),
    pluginsDir: join(home, "plugins"),
    projectsDir: join(home, "projects")
  });
  settings.models.defaultProvider = "local-test";
  settings.models.planner = "local-test/model";
  settings.models.worker = "local-test/model";
  settings.models.aggregator = "local-test/model";
  settings.enabledProviders = ["local-test"];
  settings.providers["local-test"] = {
    id: "local-test",
    name: "Local Test Provider",
    protocol: "openai-chat-completions",
    baseURL: "http://127.0.0.1/v1",
    modelListProtocol: "none",
    apiKeyEnv: "LOCAL_TEST_API_KEY",
    apiKeyRequired: false,
    auth: "none",
    models: {
      model: { name: "Local Test Model", default: true }
    }
  };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultSwarmConfig(), null, 2)}\n`, "utf8");
}

function docsExist(): boolean {
  return [
    "README.md",
    "docs/TUI_RENDERER.md",
    "docs/TUI_PRODUCT_SPEC.md"
  ].every((path) => {
    const target = resolve(packageRoot(), path);
    return existsSync(target) && readFileSync(target, "utf8").trim().length > 0;
  });
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function check(id: string, passed: boolean, detail: string): InstallSmokeCheck {
  return { id, status: passed ? "pass" : "fail", detail };
}

export function formatInstallSmokeResult(result: InstallSmokeResult): string {
  return [
    `Swarm install smoke: ${result.status}`,
    `schema=${result.schema_version}`,
    `version=${result.version}`,
    `cwd=${result.cwd}`,
    `package_root=${result.package_root}`,
    `swarm_home=${result.swarm_home}`,
    "",
    ...result.checks.map((item) => `${item.status.toUpperCase()} ${item.id}: ${item.detail}`)
  ].join("\n");
}

function isDirectCli(): boolean {
  const invoked = process.argv[1];
  return Boolean(invoked && pathToFileURL(resolve(invoked)).href === import.meta.url);
}

if (isDirectCli()) {
  runInstallSmoke().then((result) => {
    console.log(formatInstallSmokeResult(result));
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  }, (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
