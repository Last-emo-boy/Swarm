/**
 * What a node tells its peers about itself: who it is, where to reach it, what kind of machine it is, and how busy its
 * ticket host is. Peers match work and borrowed tools against these abilities.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { loadSwarmVersion } from "../runtime/headless-artifacts.js";
import { hostPort, relayName, relayOf, type Lend, type MeshNode } from "./state.js";
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
  /** host:port addresses that may reach it directly, best first. */
  addresses: string[];
  /** The relay it listens at, and its name there. */
  relay?: string;
  relayName: string;
  version: string;
  os: NodeJS.Platform;
  arch: string;
  /** Kinds of work the machine is fit for: its OS, `docker` inside a container, `gpu` with an NVIDIA GPU. */
  abilities: string[];
  /** The repository its ticket host watches, when it runs one. */
  repository?: string;
  load?: NodeLoad;
  /** The folders it lends paired peers a shell or file access in, when it lends any. */
  lend?: Lend;
  /** Set when it takes waiting work from paired nodes: only work of these repositories, or any when none. */
  pull?: { repositories: string[] };
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

const joinHost = (host: string, port: number): string => `${host.includes(":") ? `[${host}]` : host}:${port}`;

/** This machine's own IPv4 addresses on its networks (LAN, tailnet), private ones first. */
function interfaceAddresses(): string[] {
  const all = Object.values(networkInterfaces()).flat().flatMap((item) => item && item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254.") ? [item.address] : []);
  const isPrivate = (address: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address);
  return [...all.filter(isPrivate), ...all.filter((address) => !isPrivate(address))];
}

/**
 * The host:port addresses peers try to reach this node at directly: its configured address; else the concrete address it
 * binds; else, binding every interface, its tailnet address and its own network addresses. Inside a container those are
 * the container's, which nothing outside reaches, so only the tailnet address counts there. Peers that reach none of them
 * go through the relay.
 */
export async function advertisedAddresses(node: Pick<MeshNode, "listen" | "advertise">): Promise<string[]> {
  const { host, port } = parseListen(node.listen);
  const found = new Set<string>(node.advertise ? [hostPort(node.advertise)] : []);
  // Port 0 binds whatever port is free, which only the node knows once it runs: nothing to offer.
  if (!port) return [...found];
  if (host !== "0.0.0.0" && host !== "::" && host !== "tailnet") found.add(joinHost(host, port));
  else {
    const tailnet = await tailnetAddress();
    if (tailnet) found.add(joinHost(tailnet, port));
    if (host !== "tailnet" && !existsSync("/.dockerenv")) for (const address of interfaceAddresses()) found.add(joinHost(address, port));
  }
  return [...found];
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
    id: node.id, name: node.name, addresses: await advertisedAddresses(node), ...(relayOf(node) ? { relay: relayOf(node) } : {}),
    relayName: relayName(node.keys.publicKey), version: loadSwarmVersion(),
    os: process.platform, arch: process.arch, abilities: extra.abilities ?? await detectAbilities(),
    ...(extra.repository ? { repository: extra.repository } : {}),
    ...(extra.load ? { load: extra.load } : {}),
    ...(Object.keys(node.lend).length ? { lend: node.lend } : {}),
    ...(node.pull.enabled ? { pull: { repositories: node.pull.repositories } } : {}),
    at: new Date().toISOString()
  };
}
