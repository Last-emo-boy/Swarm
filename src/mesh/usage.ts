/**
 * A node's usage ledger for its paired peers: `swarm usage --all-devices` reads each peer's model calls and harness turns
 * through this route and prices them with its own settings, as it prices its own.
 */
import { loadSwarmSettings } from "../config/settings.js";
import { HttpError } from "../server/gateway-http.js";
import { readLedgerAt, type LedgerEntry } from "../usage/ledger.js";
import { callPeer } from "./client.js";
import type { MeshServer } from "./server.js";
import { readMesh, type Peer } from "./state.js";

/** The most entries one answer carries: the latest ones. */
const LIMIT = 20_000;

export interface PeerUsage { device: string; entries: LedgerEntry[]; truncated?: boolean }

/** Serves this node's ledger since `?since=<ISO time>`, from the database its settings name unless `databasePath` gives one. */
export function registerUsage(server: MeshServer, options: { databasePath?: () => string } = {}): void {
  server.route("GET", "/mesh/v1/usage", ({ query }): PeerUsage => {
    const raw = query.get("since");
    const since = raw ? new Date(raw) : undefined;
    if (since && Number.isNaN(since.getTime())) throw new HttpError(400, "since must be an ISO time");
    const device = readMesh(server.home).node.name;
    const entries = readLedgerAt(options.databasePath?.() ?? loadSwarmSettings().runtime.databasePath, device, since ? { since } : {});
    return { device, entries: entries.slice(-LIMIT), ...(entries.length > LIMIT ? { truncated: true } : {}) };
  });
}

/** A paired device's ledger since `since`, its entries under the name this node knows the device by. */
export async function peerUsage(peer: Peer, since: Date, timeoutMs = 5000): Promise<PeerUsage> {
  const answer = await callPeer<PeerUsage>(peer, "GET", `/mesh/v1/usage?since=${encodeURIComponent(since.toISOString())}`, undefined, timeoutMs);
  return { ...answer, device: peer.name, entries: answer.entries.map((entry) => ({ ...entry, device: peer.name })) };
}
