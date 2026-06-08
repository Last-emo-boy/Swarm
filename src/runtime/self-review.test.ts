import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmPaths } from "../config/settings.js";
import { createSelfReview } from "./self-review.js";

test("self review recommendations use product-facing shared fact language", async () => {
  const home = await mkdtemp(join(tmpdir(), "swarm-self-review-"));
  try {
    const paths = swarmPaths(home);
    await mkdir(paths.logsDir, { recursive: true });
    await mkdir(paths.artifactsDir, { recursive: true });
    for (let index = 0; index < 21; index += 1) {
      await writeFile(join(paths.artifactsDir, `artifact-${index}.txt`), "output", "utf8");
    }

    const review = await createSelfReview({ paths, sessions: [] });
    const recommendations = review.recommendations.join("\n");

    assert.match(recommendations, /team updates and shared facts/);
    assert.doesNotMatch(recommendations, /blackboard entries|worker notifications/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function swarmPaths(home: string): SwarmPaths {
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
    skillsDir: join(home, "skills"),
    pluginsDir: join(home, "plugins"),
    projectsDir: join(home, "projects")
  };
}
