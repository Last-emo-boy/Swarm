import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SwarmSettings } from "../config/settings.js";
import { CustomCommandProvider, renderCustomCommandObjective } from "./custom-commands.js";

test("custom command provider parses markdown frontmatter and renders objectives", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-custom-commands-"));
  try {
    const commandRoot = join(root, "commands");
    mkdirSync(commandRoot, { recursive: true });
    const commandPath = join(commandRoot, "release-check.md");
    writeFileSync(
      commandPath,
      [
        "---",
        "name: release-check",
        "title: Release Check",
        "description: Verify release readiness.",
        "argument-hint: <target>",
        "---",
        "Check release readiness for $ARGUMENTS.",
        "",
        "Return risks and checks."
      ].join("\n"),
      "utf8"
    );

    const provider = new CustomCommandProvider({
      workspace: root,
      settings: commandSettings(commandRoot)
    });
    provider.refresh();
    const command = provider.getCommand("release-check");
    const capabilities = provider.listCapabilities();

    assert.equal(command?.name, "release-check");
    assert.equal(command?.title, "Release Check");
    assert.equal(command?.argumentHint, "<target>");
    assert.equal(command?.trust, "trusted");
    assert.equal(capabilities.some((capability) => capability.id === "custom-command.release-check"), true);

    const objective = renderCustomCommandObjective(command!, "v0.1");
    assert.match(objective, /Check release readiness for v0\.1\./);
    assert.match(objective, /Custom slash command: \/release-check/);
    assert.match(objective, /Arguments: v0\.1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function commandSettings(commandRoot: string): SwarmSettings {
  return {
    extensions: {
      commands: {
        enabled: true,
        roots: [commandRoot],
        loadProjectCommands: "never",
        maxCommands: 20
      }
    }
  } as unknown as SwarmSettings;
}
