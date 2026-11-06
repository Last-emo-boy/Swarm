/**
 * A worker's link to a ticket that a paired node owns: the worker runs here, and every read of the ticket and every report
 * goes to the owner's work routes (src/mesh/work.ts), which answer with the owner's store. The ticket tools' MCP server here
 * serves the same tools, each run by the owner.
 */
import type { WorkerReport } from "../superagent/core/index.js";
import { readSettings, settingsPath } from "../superagent/settings.js";
import { proxiedTicketTools, type ReportArgs, type TicketTool } from "../superagent/ticket-tools.js";
import type { WorkLink, WorkStart, WorkView } from "../superagent/work-link.js";
import { callPeer, MeshError } from "./client.js";
import { meshHome, type Peer } from "./state.js";

const TRIES = 3;
/** How long a ticket tool may take on the owner, within the worker's 120-second limit for a tool call. */
const TOOL_TIMEOUT_MS = 110_000;

export const workPath = (ticketId: string): string => `/mesh/v1/work/tickets/${encodeURIComponent(ticketId)}`;

/**
 * Calls the owner, again after a moment while it is unreachable, as a node that restarts is for a while. A ticket tool runs
 * once: one that timed out may have run.
 */
async function owner<T>(peer: Peer, method: string, path: string, body?: unknown, tool = false): Promise<T> {
  const tries = tool ? 1 : TRIES;
  for (let attempt = 1; ; attempt++) {
    try {
      return await callPeer<T>(peer, method, path, body, tool ? TOOL_TIMEOUT_MS : undefined);
    } catch (error) {
      if (!(error instanceof MeshError) || error.status !== 0 || attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

/** The link of a worker in `directory` here to the ticket `peer` owns, for the Assignment this node holds. */
export function meshLink(peer: Peer, ticketId: string, assignmentId: string, directory: string): WorkLink {
  const base = workPath(ticketId);
  const query = `?assignment=${encodeURIComponent(assignmentId)}`;
  const post = async (path: string, body: Record<string, unknown> = {}): Promise<void> => {
    await owner(peer, "POST", `${base}/${path}`, { assignmentId, ...body });
  };
  return {
    view: async () => (await owner<{ view: WorkView | null }>(peer, "GET", `${base}${query}`)).view ?? undefined,
    start: async () => {
      // The worker concludes with this node's model, which its provider settings name; the owner's may not exist here.
      const { model: _owners, ...start } = await owner<WorkStart>(peer, "GET", `${base}/start${query}&directory=${encodeURIComponent(directory)}`);
      const model = readSettings(settingsPath()).settings.executor.model;
      return { ...start, directory, ...(model ? { model } : {}) };
    },
    delivered: (inputIds) => post("delivered", { inputIds }),
    turnEnded: () => post("turn"),
    report: (report: WorkerReport) => post("report", { report }),
    fileReport: async (args: ReportArgs) => { await owner(peer, "POST", `${base}/tools/report`, { assignmentId, args }, true); },
    tools: {
      args: ["superagent", "mcp", "--ticket", ticketId, "--assignment", assignmentId, "--remote", peer.id],
      env: { SWARM_MESH_HOME: meshHome() }
    },
    close: () => {}
  };
}

/** The ticket tools of a worker here, each run by the paired node that owns the ticket. */
export function remoteTicketTools(peer: Peer, ticketId: string, assignmentId: string): TicketTool[] {
  return proxiedTicketTools(async (name, args) => (await owner<{ result: unknown }>(peer, "POST",
    `${workPath(ticketId)}/tools/${encodeURIComponent(name)}`, { assignmentId, args }, true)).result);
}
