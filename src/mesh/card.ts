/**
 * What a node tells its peers about itself: who it is, where to reach it, what kind of machine it is, and how busy its
 * ticket host is. Peers match work and borrowed tools against these abilities.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { loadSwarmVersion } from "../runtime/headless-artifacts.js";
import { DEFAULT_MESH_PORT, type MeshNode } from "./state.js";
import { parseListen } from "./listen.js";

const exec = promisify(execFile);

export interface NodeLoad {
  /** Tickets whose workers run on this node now. */
  running: number;
  /** Tickets waiting for a worker slot. */
  queued: number;
  /** How many workers the node runs at once. */
  slots: number;
}

export interface NodeCard {
  id: string;
  name: string;
  url: string;
  version: string;
  os: NodeJS.Platform;
  arch: string;
  /** Kinds of work the machine is fit for: its OS, `docker` inside a container, `gpu` with an NVIDIA GPU. */
  abilities: string[];
  /** The repository its ticket host watches, when it runs one. */
  repository?: string;
  load?: NodeLoad;
  at: string;
}

/** The Tailscale CLI, where the standalone install or the macOS app puts it. */
const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** This device's tailnet IPv4 address, or undefined without a running, signed-in Tailscale. */
export async function tailnetAddress(): Promise<string | undefined> {
  for (const cli of TAILSCALE) {
    try {
      const { stdout } = await exec(cli, ["ip", "-4"], { timeout: 5000 });
      const address = stdout.trim().split(/\s+/)[0];
      if (address && /^\d+\.\d+\.\d+\.\d+$/.test(address)) return address;
    } catch { /* Not installed here, or not signed in: try the next place. */ }
  }
  return undefined;
}

const wildcard = (host: string): boolean => host === "0.0.0.0" || host === "::" || host === "tailnet" || host === "localhost" || host === "::1" || host.startsWith("127.");

/**
 * The URL peers call this node at: its configured address; else the concrete address it binds; else its tailnet
 * address, which works inside containers where tailnet names do not resolve; else its hostname.
 */
export async function advertisedUrl(node: MeshNode): Promise<string> {
  if (node.advertise) return node.advertise.replace(/\/$/, "");
  const { host, port } = parseListen(node.listen);
  const reach = !wildcard(host) ? host : await tailnetAddress() ?? hostname();
  return `http://${reach.includes(":") ? `[${reach}]` : reach}:${port || DEFAULT_MESH_PORT}`;
}

export async function detectAbilities(): Promise<string[]> {
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
  const abilities = [os];
  if (existsSync("/.dockerenv")) abilities.push("docker");
  const gpu = await exec("nvidia-smi", ["-L"], { timeout: 5000 }).then((result) => /GPU \d+:/.test(result.stdout), () => false);
  if (gpu) abilities.push("gpu");
  return abilities;
}

export async function nodeCard(node: MeshNode, extra: { repository?: string; load?: NodeLoad; abilities?: string[] } = {}): Promise<NodeCard> {
  return {
    id: node.id, name: node.name, url: await advertisedUrl(node), version: loadSwarmVersion(),
    os: process.platform, arch: process.arch, abilities: extra.abilities ?? await detectAbilities(),
    ...(extra.repository ? { repository: extra.repository } : {}),
    ...(extra.load ? { load: extra.load } : {}),
    at: new Date().toISOString()
  };
}
