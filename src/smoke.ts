import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSelectedModelReadiness, hasUsableModelConfiguration, loadSwarmConfig, loadSwarmSettings } from "./config/settings.js";

const settings = loadSwarmSettings();
const config = loadSwarmConfig();
const readiness = getSelectedModelReadiness(settings, config);

if (!hasUsableModelConfiguration(settings, config)) {
  console.log("No usable model provider configured; skipping live swarm E2E smoke.");
  for (const item of readiness) {
    console.log(`${item.modelRef}: ${item.configured ? "configured" : item.reason}`);
  }
  process.exit(0);
}

const smokeHome = resolve(process.cwd(), ".swarm", "smoke-home");
mkdirSync(smokeHome, { recursive: true });
const smokeSettings = structuredClone(settings);
smokeSettings.permissions.defaultMode = "full-auto";
smokeSettings.permissions.deny = [];
smokeSettings.runtime.taskTimeoutMs = Math.max(smokeSettings.runtime.taskTimeoutMs, 300_000);
writeFileSync(resolve(smokeHome, "settings.json"), `${JSON.stringify(smokeSettings, null, 2)}\n`, "utf8");
writeFileSync(resolve(smokeHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
process.env.SWARM_HOME = smokeHome;

const { SwarmRuntime } = await import("./runtime/runtime.js");
const runtime = new SwarmRuntime({
  databasePath: ".swarm/smoke.db",
  workspace: process.cwd(),
  approvalHandler: async () => true
});

runtime.events.onEvent((event) => {
  if (event.type === "final") {
    console.log(`FINAL ${event.session_id} ${event.artifact_path ?? ""}`);
  }
  if (event.type === "error") {
    console.error(event.message);
  }
});

try {
  const planned = await runtime.createPlan(
    "Read the current workspace and produce a concise implementation status summary for the Agent Swarm Protocol CLI."
  );
  const result = await runtime.execute(planned);
  console.log(result.content.slice(0, 500));
  runtime.dispose();
} catch (error) {
  runtime.dispose();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
