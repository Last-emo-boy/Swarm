/**
 * What the superagent runs its tickets' work on now: this node; its paired mesh nodes, with whether they answered, what
 * kind of machine each is and the agent harnesses signed in there; and how many of its tickets' workers run at once and
 * how many of those are busy, as processes on this node or as ticket VMs here and in the cluster. The router's card holds
 * it, so the agent answers questions about its devices from it (assessor.ts), and `/devices` prints it (bot-commands.ts).
 * Which nodes these are is for maintainers and owners (`seesNodes`); everyone else gets counts.
 */
import type { SuperagentClient } from "./client.js";
import { harnessAbility, harnessIds } from "./harness.js";
import type { MeshView, NodeAbilities } from "./placement.js";
import type { Settings } from "./settings.js";
import type { Say } from "./text.js";
import { vmHarnessIds, vmSlotCounts, type SlotCount } from "./vm/vm-work.js";

/** A node as the agent sees it: what kind of machine it is (its OS, `docker`, `gpu`) and the harnesses signed in there. */
export interface DeviceNode { name: string; machine: string[]; harnesses: string[] }
/** A paired node; one that did not answer just now shows no machine or harnesses. */
export interface PairedNode extends DeviceNode { online: boolean }
/** Where this node runs its tickets' workers: as processes of its own, or each in a VM of its own here and in the cluster. */
export type Workers = { isolation: "process"; slots: SlotCount } | { isolation: "vm"; local: SlotCount; cluster?: SlotCount };
export interface Devices {
  /** This node, whose name only a mesh node has. */
  here: Omit<DeviceNode, "name"> & { name?: string };
  peers: PairedNode[];
  workers: Workers;
}

const HARNESS = harnessAbility("");
const split = ({ abilities }: Pick<NodeAbilities, "abilities">): Omit<DeviceNode, "name"> => ({
  machine: abilities.filter((ability) => !ability.startsWith(HARNESS)),
  harnesses: abilities.filter((ability) => ability.startsWith(HARNESS)).map((ability) => ability.slice(HARNESS.length))
});

/**
 * The devices of a host with `settings`, from its mesh view, when it is a mesh node, and the worker processes it runs now.
 * A host that is no mesh node counts every harness profile it would run as its own, as the router's harness choices do.
 */
export function devicesOf(input: { settings: Settings; store: Pick<SuperagentClient["store"], "get">; view?: MeshView; running: number }): Devices {
  const { executor } = input.settings;
  const { view } = input;
  const here = view ? { name: view.here.name, ...split(view.here) }
    : { machine: [], harnesses: executor.isolation === "vm" ? vmHarnessIds(executor.harnesses) : harnessIds(executor.harnesses) };
  const peers = view ? [...view.peers.map((peer) => ({ name: peer.name, online: true, ...split(peer) })),
    ...(view.offline ?? []).map((name) => ({ name, online: false, machine: [], harnesses: [] }))] : [];
  const workers: Workers = executor.isolation === "vm" ? { isolation: "vm", ...vmSlotCounts(input.store, executor.vm) }
    : { isolation: "process", slots: { total: executor.maxWorkers, busy: input.running, free: Math.max(0, executor.maxWorkers - input.running) } };
  return { here, peers, workers };
}

/** The router's card of the devices: every node with what it runs when `names`, else counts alone. */
export function devicesCard(devices: Devices, names: boolean): Record<string, unknown> {
  const { workers } = devices;
  const ticketWorkers = workers.isolation === "process" ? { runs_as: "processes on this node", ...workers.slots }
    : { runs_as: "a VM of its own for each ticket; the cluster takes tickets once this node's VMs are busy",
      ...(workers.local.total ? { on_this_node: workers.local } : {}), ...(workers.cluster ? { in_the_cluster: workers.cluster } : {}) };
  if (!names) {
    return { paired_nodes: { total: devices.peers.length, online: devices.peers.filter((peer) => peer.online).length }, ticket_workers: ticketWorkers,
      node_names: "only maintainers and owners see which nodes these are and what each runs: give this requester counts" };
  }
  return {
    this_node: devices.here,
    paired_nodes: devices.peers.map((peer) => peer.online ? peer : { name: peer.name, online: false }),
    ticket_workers: ticketWorkers
  };
}

/** `/devices`'s answer: the nodes with what each runs when `names`, else how many there are; then the free workers. */
export function devicesText(devices: Devices, names: boolean, say: Say): string {
  const list = (items: readonly string[]) => items.join(say(", ", "、"));
  const about = (node: Omit<DeviceNode, "name">): string => {
    const parts = [...node.machine.length ? [list(node.machine)] : [], ...node.harnesses.length ? [say(`harnesses: ${list(node.harnesses)}`, `harness：${list(node.harnesses)}`)] : []];
    return parts.length ? say(` (${parts.join("; ")})`, `（${parts.join("；")}）`) : "";
  };
  const online = devices.peers.filter((peer) => peer.online).length;
  const peers = devices.peers.map((peer) => peer.online ? say(`${peer.name}, online${about(peer)}`, `${peer.name} 在线${about(peer)}`)
    : say(`${peer.name}, offline`, `${peer.name} 离线`));
  const nodes = !names ? [say(`Paired nodes: ${devices.peers.length}, ${online} online.`, `配对节点：${devices.peers.length} 个，${online} 个在线。`)] : [
    say(`This node: ${devices.here.name ?? "this host"}${about(devices.here)}.`, `本机：${devices.here.name ?? "这台主机"}${about(devices.here)}。`),
    peers.length ? say(`Paired nodes: ${peers.join("; ")}.`, `配对节点：${peers.join("；")}。`) : say("Paired nodes: none.", "配对节点：没有。")
  ];
  const { workers } = devices;
  const free = (count: SlotCount, where: "here" | "cluster") => where === "here"
    ? say(`${count.free} of ${count.total} free here`, `本机 ${count.total} 台，空闲 ${count.free} 台`)
    : say(`${count.free} of ${count.total} free in the cluster`, `集群 ${count.total} 台，空闲 ${count.free} 台`);
  const vms = workers.isolation === "vm" ? [...workers.local.total ? [free(workers.local, "here")] : [], ...workers.cluster ? [free(workers.cluster, "cluster")] : []] : [];
  const capacity = workers.isolation === "process"
    ? say(`Workers: ${workers.slots.free} of ${workers.slots.total} free, as processes on this node.`,
      `worker：${workers.slots.total} 个，空闲 ${workers.slots.free} 个，在本机以进程运行。`)
    : say(`Ticket VMs: ${vms.join(", ")}.`, `工单 VM：${vms.join("；")}。`);
  const hidden = names ? [] : [say("Only maintainers and owners see which nodes these are.", "只有 maintainer 和 owner 能看到具体是哪些节点。")];
  return [...nodes, capacity, ...hidden].join(say(" ", ""));
}
