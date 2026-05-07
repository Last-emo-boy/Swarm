import type { BlackboardEntry, SwarmSession, WorkItem } from "../protocol/types.js";
import type { SwarmRuntime } from "../runtime/runtime.js";
import { loadWorkflow, normalizeWorkflowConfig, renderWorkflowPrompt, type WorkflowLoadResult } from "./workflow.js";
import { createWorkSourceFromConfig, type LocalWorkRecord } from "./work-source.js";
import { prepareWorkItemWorkspace } from "./workspace.js";
import { createSymphonyWorkSession, workItemToTemplateIssue } from "./kernel.js";

export type SymphonyPreviewResult = {
  workflow: WorkflowLoadResult;
  items: WorkItem[];
  sessions: Array<{
    session: SwarmSession;
    workspace_path: string;
    prompt: string;
    blackboard_entry: BlackboardEntry;
  }>;
};

export async function createSymphonyPreview(input: {
  runtime: SwarmRuntime;
  workflowPath?: string;
  records?: LocalWorkRecord[];
  createWorkspace?: boolean;
}): Promise<SymphonyPreviewResult> {
  const workflow = loadWorkflow(input.workflowPath);
  if (!workflow.ok) {
    return { workflow, items: [], sessions: [] };
  }
  const config = normalizeWorkflowConfig(workflow.workflow);
  const source = createWorkSourceFromConfig(config, { records: input.records });
  const items = await source.fetchCandidateItems();
  const sessions: SymphonyPreviewResult["sessions"] = [];
  for (const item of items) {
    const session = createSymphonyWorkSession({
      item,
      maxAgents: config.agent.max_concurrent_agents,
      timeoutMs: input.runtime.settings.runtime.taskTimeoutMs
    });
    const prepared = prepareWorkItemWorkspace({
      item,
      session_id: session.session_id,
      workspace_root: config.workspace.root,
      create: input.createWorkspace ?? true
    });
    const lease = input.runtime.workspaceLeaseStore.create(prepared.lease);
    session.workspace_lease_id = lease.lease_id;
    input.runtime.sessionStore.createIfMissing(session);
    input.runtime.sessionStore.updateMetadata(session.session_id, {
      source: item,
      workspace_lease_id: lease.lease_id
    });
    const issue = workItemToTemplateIssue(item);
    const prompt = renderWorkflowPrompt({
      workflow: workflow.workflow,
      issue,
      attempt: null
    });
    const entry = input.runtime.blackboardStore.write({
      swarm_id: session.swarm_id,
      session_id: session.session_id,
      key: "symphony.preview",
      type: "plan",
      value: {
        workflow_path: workflow.workflow.path,
        work_item: item,
        workspace_path: prepared.workspace_path,
        prompt
      },
      created_by: { agent_id: "symphony", role: "work-source" },
      tags: ["symphony", "preview", "workflow"]
    });
    input.runtime.events.emitEvent({ type: "blackboard", entry });
    input.runtime.events.emitEvent({ type: "session", session_id: session.session_id, status: session.status, objective: session.objective });
    sessions.push({
      session,
      workspace_path: prepared.workspace_path,
      prompt,
      blackboard_entry: entry
    });
  }
  return { workflow, items, sessions };
}
