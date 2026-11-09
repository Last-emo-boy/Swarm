/**
 * Execution variables: what the prepare command reads from its environment and the worker reads in its prompt, registered by
 * the Executor and by each Source that is on (from dsh-superagent's app/execution-environment.ts). None holds a credential.
 */
import type { Ticket, Trigger } from "./core/index.js";
import type { Settings } from "./settings.js";
import type { Deployment } from "./setup.js";
import type { SourceRegistry } from "./sources/registry.js";

export interface Variable { key: string; value: string; description: string; owner: string }

const EXECUTOR_VARIABLES: readonly { key: string; description: string; ticket?: true }[] = [
  { key: "SWARM_TICKET_DIR", ticket: true, description: "This ticket's directory; its worker works in it" },
  { key: "SWARM_TICKET_NAME", ticket: true, description: "The ticket's short name, also its directory's name and the last segment of its branch" },
  { key: "SWARM_TICKET_ID", ticket: true, description: "The ticket id" },
  { key: "SWARM_TICKET_BLOCKED_COMMANDS", description: "Commands blocked in this execution environment, separated by spaces; never run them" }
];

export function ticketVariables(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input;
  const executor: Record<string, string> = {
    SWARM_TICKET_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(" "),
    SWARM_TICKET_DIR: ticket.execution?.directory ?? "",
    SWARM_TICKET_NAME: ticket.execution?.name ?? "",
    SWARM_TICKET_ID: ticket.id
  };
  const result: Variable[] = EXECUTOR_VARIABLES.map((spec) => ({ key: spec.key, value: executor[spec.key] ?? "", description: spec.description, owner: "executor" }));
  // A ticket that writes to GitHub as its requester's account names that account and its repository instead of the agent's.
  const { credential, repository } = ticket.mandate.capability ?? {};
  const requester: Record<string, string> = credential && repository ? { SWARM_TICKET_GITHUB_REPOSITORY: repository,
    SWARM_TICKET_GITHUB_ACCOUNT: credential.login, SWARM_TICKET_GITHUB_COMMIT_EMAIL: `${credential.id}+${credential.login}@users.noreply.github.com` } : {};
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = { ...environment.values({ deployment, config, ...(trigger ? { trigger } : {}) }), ...kind.kind === "github" ? requester : {} };
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? "", description: spec.description, owner: kind.kind });
  }
  return result;
}

export const variableValues = (variables: readonly Variable[]): Record<string, string> =>
  Object.fromEntries(variables.map((variable) => [variable.key, variable.value]));
export const variableLines = (variables: readonly Variable[]): string =>
  variables.map((variable) => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description}.`).join("\n");
