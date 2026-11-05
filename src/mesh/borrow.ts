/**
 * Borrowing the tools paired devices lend: one http MCP server per reachable peer that lends any, named after the peer
 * and called with the token it issued this node, so a Swarm session sees them as `mcp__<peer>__<tool>`.
 */
import type { McpServerSettings } from "../config/settings.js";
import type { CapabilityDiagnostic } from "../extensions/types.js";
import { peerHealth } from "./client.js";
import { LEND_CALL_MS, lentTools } from "./lend.js";
import { meshHome, meshPeers } from "./state.js";

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
    servers[peer.name] = {
      transport: "http", url: `${peer.url}/mesh/v1/mcp`, headers: { authorization: `Bearer ${peer.token}` },
      trust: "user", timeoutMs: LEND_CALL_MS
    };
  }
  return { servers, diagnostics };
}
