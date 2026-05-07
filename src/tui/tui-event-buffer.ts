import type { RuntimeEvent } from "../runtime/events.js";
import { formatRuntimeEventBrief } from "../runtime/event-formatters.js";

export const TUI_EVENT_BUFFER_LIMIT = 80;

export function appendTuiRuntimeEvent(
  previous: RuntimeEvent[],
  event: RuntimeEvent,
  limit = TUI_EVENT_BUFFER_LIMIT
): RuntimeEvent[] {
  const last = previous[previous.length - 1];
  if (last && runtimeEventDisplaySignature(last) === runtimeEventDisplaySignature(event)) {
    return previous;
  }
  return [...previous.slice(-(Math.max(1, limit) - 1)), event];
}

export function runtimeEventDisplaySignature(event: RuntimeEvent): string {
  switch (event.type) {
    case "loop_activity":
      return `${event.type}:${event.session_id}:${event.phase}:${event.turn ?? ""}:${event.tool ?? ""}:${event.task_id ?? ""}:${event.message}`;
    case "progress":
      return `${event.type}:${event.completed}/${event.total}`;
    case "task":
      return `${event.type}:${event.task_id}:${event.status}:${event.title}`;
    case "task_attempt":
      return `${event.type}:${event.session_id ?? ""}:${event.task_id}:${event.attempt}:${event.status}:${event.title}`;
    case "tool_result":
      return `${event.type}:${event.session_id ?? ""}:${event.task_id}:${event.action}:${event.status ?? ""}:${event.summary}:${event.outputRef ?? ""}`;
    case "worker":
      return `${event.type}:${event.worker.worker_id}:${event.worker.status}:${event.worker.updated_at}:${event.message ?? ""}`;
    case "handoff_message":
      return `${event.type}:${event.handoff_id}:${event.message}`;
    default:
      return `${event.type}:${formatRuntimeEventBrief(event)}`;
  }
}
