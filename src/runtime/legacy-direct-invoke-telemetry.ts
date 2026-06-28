import type { RuntimeEvents } from "./events.js";

export type LegacyDirectInvokeTelemetryInput = {
  worker_id: string;
  worker_actor_id: string;
  parent_session_id?: string;
  agent_spec_id?: string;
  invocation_mode?: string;
  assignment_envelope_id?: string;
};

export function formatLegacyDirectInvokeAdapterTelemetry(input: LegacyDirectInvokeTelemetryInput): string {
  return [
    `Legacy direct invoke adapter fallback: ${input.worker_actor_id} is still executed by the main runtime after mailbox assignment.`,
    "protocol=local_worker_actor_adapter",
    `worker_id=${input.worker_id}`,
    input.parent_session_id ? `session_id=${input.parent_session_id}` : undefined,
    input.agent_spec_id ? `agent_spec_id=${input.agent_spec_id}` : undefined,
    input.invocation_mode ? `invocation_mode=${input.invocation_mode}` : undefined,
    input.assignment_envelope_id ? `assignment_envelope_id=${input.assignment_envelope_id}` : undefined
  ].filter((part): part is string => typeof part === "string").join(" ");
}

export function emitLegacyDirectInvokeAdapterTelemetry(events: RuntimeEvents, input: LegacyDirectInvokeTelemetryInput): void {
  events.emitEvent({
    type: "log",
    level: "warn",
    message: formatLegacyDirectInvokeAdapterTelemetry(input)
  });
}
