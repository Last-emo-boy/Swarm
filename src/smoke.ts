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
