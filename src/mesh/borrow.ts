/**
 * Borrowing the tools paired devices lend: one http MCP server per reachable peer that lends any, named after the peer
 * and reached over its link, so a Swarm session sees them as `mcp__<peer>__<tool>`. A ticket's worker, which runs where it
 * is no mesh node, such as in a ticket VM, borrows them through its host with `lentByPeers` and `callLent`.
 */
import { posix, win32 } from "node:path";
import type { McpServerSettings } from "../config/settings.js";
import type { CapabilityDiagnostic } from "../extensions/types.js";
import type { NodeCard } from "./card.js";
import { callPeer, MeshError, peerHealth } from "./client.js";
import { withLease } from "./leases.js";
import { BORROWER_HEADER, LEND_CALL_MS, lentTools } from "./lend.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { peerFetch } from "./link.js";
import { findPeer, meshHome, meshPeers, readMesh, type Peer } from "./state.js";

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
    // Two peers that share a name keep apart under their ids, so one never answers for the other.
    const shared = peers.filter((item) => item.name === peer.name).length > 1;
    servers[shared ? `${peer.name}-${peer.id.slice(0, 6)}` : peer.name] = { transport: "http", url: meshMcpUrl(peer.id), trust: "user", timeoutMs: LEND_CALL_MS };
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

/**
 * The lent folder a shell call runs in on `peer`, which its lease names: the one that holds an absolute `cwd`, else the
 * first, where a relative cwd starts. The lender checks it again against where the command really runs.
 */
async function shellRoot(peer: Peer, cwd: unknown): Promise<string> {
  const card = await callPeer<NodeCard>(peer, "GET", "/mesh/v1/node", undefined, 5000);
  const roots = card.lend?.shell?.roots ?? [];
  if (!roots.length) throw new Error(`${peer.name} lends no shell`);
  // The lender's paths, in its own form: a relative cwd starts at its first folder, as the lender resolves it.
  const paths = roots[0]!.startsWith("/") ? posix : win32;
  const path = paths.resolve(roots[0]!, typeof cwd === "string" ? cwd : ".");
  const inside = (root: string): boolean => { const rel = paths.relative(root, path); return rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel); };
  return roots.find(inside) ?? roots[0]!;
}

/**
 * A fetch for the tools `peerId` lends, over its link: a shell call first takes a lease on its folder from that node, as
 * the lender asks of every command it runs, and names `borrower` when one is given.
 */
export function lentToolFetch(peerId: string, home = meshHome(), borrower?: string): typeof fetch {
  const fetchOver = peerFetch(() => findPeer(readMesh(home), peerId));
  return async (input, init) => {
    const call = shellCall(init?.body);
    const extra: Record<string, string> = borrower ? { [BORROWER_HEADER]: borrower } : {};
    if (!call) return fetchOver(input, withHeaders(init, extra));
    const peer = findPeer(readMesh(home), peerId);
    return withLease(peer, "lend.shell", await shellRoot(peer, call.cwd), async (headers) => {
      const answer = await fetchOver(input, withHeaders(init, { ...extra, ...headers }));
      // A refused lease comes back as an HTTP error, which withLease answers by asking for a fresh one.
      if (answer.status === 403) {
        const refusal = await answer.clone().json().catch(() => ({})) as { error?: { message?: string } };
        if (refusal.error?.message && /lease/.test(refusal.error.message)) throw new MeshError(403, refusal.error.message);
      }
      return answer;
    }, borrower ? `shell for ${borrower}` : "shell");
  };
}
/** The arguments of a JSON-RPC body that calls the lent shell, or undefined for any other call. */
function shellCall(body: unknown): { cwd?: unknown } | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown; arguments?: { cwd?: unknown } } };
    return message.method === "tools/call" && message.params?.name === "shell" ? { cwd: message.params.arguments?.cwd } : undefined;
  } catch {
    return undefined;
  }
}
const withHeaders = (init: RequestInit | undefined, headers: Record<string, string>): RequestInit =>
  ({ ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } });

/**
 * Calls a tool a paired node lends, over its link, and answers what it returned: its JSON, or its text. `node` is the
 * peer's id or its name; two peers that share a name are told apart by id. `borrower` says what the call is for.
 */
export async function callLent(node: string, tool: string, args: Record<string, unknown>, timeoutMs: number, home = meshHome(), borrower?: string): Promise<unknown> {
  const peers = meshPeers(home);
  let peer: Peer;
  const listed = peers.map((item) => `${item.name} (${item.id.slice(0, 8)})`).join(", ") || "none";
  try {
    peer = findPeer(readMesh(home), node);
  } catch (error) {
    const ambiguous = error instanceof Error && /matches/.test(error.message);
    throw new Error(ambiguous ? `${error.message}: name it by its id; the paired nodes are ${listed}` : `No paired node is called ${node}: the paired nodes are ${listed}`);
  }
  const client = new Client({ name: "swarm-ticket-mesh", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(meshMcpUrl(peer.id)), { fetch: lentToolFetch(peer.id, home, borrower) }));
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
