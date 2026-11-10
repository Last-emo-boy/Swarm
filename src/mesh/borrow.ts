/**
 * Borrowing the tools paired devices lend: one http MCP server per reachable peer that lends any, named after the peer
 * and reached over its link, so a Swarm session sees them as `mcp__<peer>__<tool>`. A ticket's worker, which runs where it
 * is no mesh node, such as in a ticket VM, borrows them through its host with `lentByPeers` and `callLent`.
 */
import type { McpServerSettings } from "../config/settings.js";
import type { CapabilityDiagnostic } from "../extensions/types.js";
import { peerHealth } from "./client.js";
import { LEND_CALL_MS, lentTools } from "./lend.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { peerFetch } from "./link.js";
import { findPeer, meshHome, meshPeers, readMesh } from "./state.js";

/** The URL of a peer's lent tools; the host is the peer's id, and the MCP client fetches it over the peer's link. */
export const meshMcpUrl = (peerId: string): string => `swarm-mesh://${peerId}/mesh/v1/mcp`;

/** The MCP servers for what reachable peers lend; a peer that does not answer is skipped with a diagnostic. */
export async function borrowedMcpServers(home = meshHome(), timeoutMs = 3000): Promise<{ servers: Record<string, McpServerSettings>; diagnostics: CapabilityDiagnostic[] }> {
  const peers = meshPeers(home);
  const servers: Record<string, McpServerSettings> = {};
  const diagnostics: CapabilityDiagnostic[] = [];
  if (!peers.length) return { servers, diagnostics };
  for (const health of await peerHealth(home, timeoutMs)) {
    const peer = peers.find((item) => item.id === health.peer.id);
    if (!peer) continue;
    if (!health.reachable) {
      diagnostics.push({ severity: "info", code: "MCP_MESH_PEER_UNREACHABLE", message: `Skipped the tools ${peer.name} lends: ${health.error}` });
      continue;
    }
    if (!lentTools(health.card?.lend).length) continue;
    // The MCP client reaches a swarm-mesh: URL over the peer's link (src/extensions/mcp.ts), which its key authenticates.
    servers[peer.name] = { transport: "http", url: meshMcpUrl(peer.id), trust: "user", timeoutMs: LEND_CALL_MS };
  }
  return { servers, diagnostics };
}

/** A paired node as a borrower sees it now: the folders it lends a shell and file access in and their tools, or why it cannot tell. */
export interface Lender { node: string; online: boolean; shell?: string[]; files?: string[]; tools: string[]; error?: string }

/** What each paired node lends now, read from the cards of those that answer. */
export async function lentByPeers(home = meshHome(), timeoutMs = 5000): Promise<Lender[]> {
  return (await peerHealth(home, timeoutMs)).map((health): Lender => {
    if (!health.reachable) return { node: health.peer.name, online: false, tools: [], ...(health.error ? { error: health.error } : {}) };
    const lend = health.card?.lend;
    return { node: health.peer.name, online: true, ...(lend?.shell ? { shell: lend.shell.roots } : {}), ...(lend?.files ? { files: lend.files.roots } : {}), tools: lentTools(lend) };
  });
}

/** Calls a tool a paired node lends, over its link, and answers what it returned: its JSON, or its text. */
export async function callLent(node: string, tool: string, args: Record<string, unknown>, timeoutMs: number, home = meshHome()): Promise<unknown> {
  const peers = meshPeers(home);
  const peer = peers.find((item) => item.name === node);
  if (!peer) throw new Error(`No paired node is called ${node}: the paired nodes are ${peers.map((item) => item.name).join(", ") || "none"}`);
  const client = new Client({ name: "swarm-ticket-mesh", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(meshMcpUrl(peer.id)), { fetch: peerFetch(() => findPeer(readMesh(home), peer.id)) }));
  try {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
    const text = (Array.isArray(result.content) ? result.content : []).flatMap((part: { type?: string; text?: string }) => part.type === "text" && part.text ? [part.text] : []).join("\n");
    let answer: unknown = text;
    try { answer = JSON.parse(text); } catch { /* A tool that answers in words is passed on as they are. */ }
    if (result.isError) throw new Error(`${node} refused ${tool}: ${typeof answer === "string" ? answer : JSON.stringify(answer)}`.slice(0, 2000));
    return answer;
  } finally {
    await client.close();
  }
}
