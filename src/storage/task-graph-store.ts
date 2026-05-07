import type { GeneratedPlan, SwarmTask, TaskStateSnapshot } from "../protocol/types.js";
import type { SwarmDatabase } from "./database.js";
import type { TaskStateStore } from "./task-state-store.js";

export type TaskGraphEdge = {
  session_id: string;
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
};

export type TaskGraph = {
  session_id: string;
  tasks: TaskStateSnapshot[];
  edges: TaskGraphEdge[];
};

export class TaskGraphStore {
  constructor(
    private readonly database: SwarmDatabase,
    private readonly taskStates: TaskStateStore
  ) {}

  storePlan(sessionId: string, plan: GeneratedPlan): void {
    const now = new Date().toISOString();
    const deleteEdges = this.database.db.prepare("DELETE FROM task_graph_edges WHERE session_id = ?");
    deleteEdges.run(sessionId);
    const insertEdge = this.database.db.prepare(
      "INSERT OR IGNORE INTO task_graph_edges (session_id, task_id, depends_on_task_id, created_at) VALUES (?, ?, ?, ?)"
    );
    for (const task of plan.tasks) {
      for (const dependency of task.dependencies ?? []) {
        insertEdge.run(sessionId, task.task_id, dependency, now);
      }
    }
  }

  upsertSyntheticTool(input: {
    session_id: string;
    swarm_id: string;
    task_id: string;
    title: string;
    action: string;
    status: SwarmTask["status"];
    attempt?: number;
  }): TaskStateSnapshot {
    return this.taskStates.upsert({
      session_id: input.session_id,
      swarm_id: input.swarm_id,
      task: {
        task_id: input.task_id,
        title: input.title,
        description: input.title,
        objective: input.title,
        type: "tool_call",
        status: input.status,
        required_capabilities: [input.action],
        inputs: { action: input.action },
        expected_output: { format: "text" },
        dependencies: []
      },
      status: input.status,
      attempt: input.attempt
    });
  }

  get(sessionId: string): TaskGraph {
    const rows = this.database.db
      .prepare("SELECT * FROM task_graph_edges WHERE session_id = ? ORDER BY task_id, depends_on_task_id")
      .all(sessionId) as TaskGraphEdge[];
    return {
      session_id: sessionId,
      tasks: this.taskStates.list(sessionId),
      edges: rows
    };
  }
}
