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

/** This device's tailnet DNS name, or undefined without a running Tailscale. */
export async function tailnetName(): Promise<string | undefined> {
  for (const cli of TAILSCALE) {
    try {
      const { stdout } = await exec(cli, ["status", "--json"], { timeout: 5000 });
      const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
      if (name) return name;
    } catch { /* Not installed here, or not signed in: try the next place, then fall back to the hostname. */ }
  }
  return undefined;
}

/** The URL peers call this node at: its configured address, else its tailnet name, else its hostname, on its port. */
export async function advertisedUrl(node: MeshNode): Promise<string> {
  if (node.advertise) return node.advertise.replace(/\/$/, "");
  const port = Number(node.listen.split(":").at(-1)) || DEFAULT_MESH_PORT;
  return `http://${await tailnetName() ?? hostname()}:${port}`;
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
