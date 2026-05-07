import { slashCommands } from "../tui/slash-commands.js";
import type { CapabilityDescriptor, CapabilityProvider } from "./types.js";

const WRITE_OR_EXEC_COMMANDS = new Set([
  "shell",
  "evals",
  "improve-self",
  "symphony-tick",
  "symphony-run-once",
  "symphony-start",
  "symphony-stop",
  "symphony-cleanup",
  "stop-worker",
  "continue-agent",
  "takeback",
  "provider",
  "model",
  "refresh-models",
  "permission-mode"
]);

export class SlashCommandProvider implements CapabilityProvider {
  readonly id = "slash-commands";
  readonly title = "TUI slash commands";

  listCapabilities(): CapabilityDescriptor[] {
    return slashCommands.map((command) => ({
      id: `slash.${command.name}`,
      kind: "slash_command",
      source: "builtin",
      trust: "builtin",
      providerId: this.id,
      name: `/${command.name}`,
      title: command.usage,
      description: command.description,
      inputSchema: {
        type: "string",
        usage: command.usage
      },
      riskClass: WRITE_OR_EXEC_COMMANDS.has(command.name) ? "r2" : "r0",
      permissionName: `SlashCommand(${command.name})`,
      modelVisible: false,
      userVisible: true,
      status: "available",
      metadata: {
        group: command.group,
        usage: command.usage,
        aliases: command.aliases ?? []
      }
    }));
  }
}

