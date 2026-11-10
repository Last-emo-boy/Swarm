/**
 * Cluster ticket VMs: with `executor.vm.kube`, tickets that find this host's ticket VMs full boot in pods of a Kubernetes
 * cluster instead. Each pod runs QEMU with the node's /dev/kvm (a device plugin's resource, so the pod needs no
 * privileges), the same image a local ticket VM boots, and the ticket's data disk on a volume of its own. Its guest
 * reaches its slot's gateway on this host through the deployment's tunnel: a pod in the cluster whose port for the slot
 * this host forwards to the gateway over SSH (vm/vm-work.ts listens on `kube.port` plus the slot).
 *
 * The deployment sets the cluster up once (its namespace, the device plugin, the tunnel, and network policies that let a
 * ticket pod reach the internet and its own slot's tunnel port, and nothing else in the cluster); this host only creates
 * and deletes ticket pods, their token Secrets and volumes, and keeps the policy's list of the nodes' public addresses,
 * which change as the cluster scales, current. A pod's Secret comes last, once the pod has a node whose address the policy
 * keeps it from: until then the pod cannot mount it, so nothing in it runs, on a node the cluster just added either.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { KubeVm } from "../settings.js";

/** Starts and stops the cluster's ticket VMs: each boot is a pod of its own (podName). */
export interface ClusterControl {
  /**
   * Boots the ticket in cluster slot `index` as pod `pod`, with its volume (made on its first boot) and the slot's token;
   * resolves once the pod has its token, which may take a new node's start.
   */
  start(index: number, pod: string, ticketId: string, token: string): Promise<void>;
  /** Deletes a boot's pod and its token, without waiting for its VM to stop. */
  stop(pod: string): Promise<void>;
  /** Deletes an ended ticket's volume, which the cluster keeps until no pod uses it. */
  discard(ticketId: string): Promise<void>;
  /** Keeps the ticket pods from the nodes' public addresses. */
  guard(): Promise<void>;
}

const APP = "swarm-ticket", SLOT = "swarm.w33d.xyz/slot", TICKET = "swarm.w33d.xyz/ticket";
/** The device plugin's resource for /dev/kvm, and the group that owns /dev/kvm on the nodes. */
const KVM = "swarm.w33d.xyz/kvm", KVM_GROUP = 109;
/**
 * The taint of the cluster's nodes for tickets, which ticket pods tolerate: a pool of them, apart from the nodes the
 * cluster's own pods run on, has nodes only while tickets need them.
 */
const TICKET_NODES = "swarm.w33d.xyz/tickets";
/** The runner image's user, which owns the volume's files. */
const RUNNER_USER = 10_001;
/** The tunnel's Service, and the egress policy whose list of nodes' addresses this host keeps, in the annotation below. */
const TUNNEL = "swarm-tunnel", EGRESS = "swarm-ticket-egress", NODES = "swarm.w33d.xyz/nodes";
/** Memory QEMU takes beyond its guest's. */
const QEMU_MIB = 512;
/** How long a boot waits for its pod to get a node, which the cluster may add for it. */
const SCHEDULE_MS = 20 * 60_000;

export const volumeName = (ticketId: string): string => `swarm-ticket-${ticketId}`;
/** A new name for a boot's pod, and its token Secret, in cluster slot `index`. */
export const podName = (index: number): string => `swarm-ticket-${index}-${randomBytes(3).toString("hex")}`;
/**
 * A volume for a data disk of `diskGiB`: the disk is a growing image file on it, and a volume's filesystem keeps some of it
 * for itself.
 */
const volumeGiB = (diskGiB: number): number => diskGiB + Math.ceil(diskGiB / 10) + 1;

interface Policy {
  metadata: { annotations?: Record<string, string> };
  spec: { egress?: { to?: { ipBlock?: { cidr: string; except?: string[] } }[] }[] };
}

export class KubeControl implements ClusterControl {
  private guarding?: Promise<void>;

  constructor(private readonly settings: () => KubeVm, private readonly command = "kubectl", private readonly pollMs = 3000) {}

  private kubeconfig(): string {
    const { kubeconfig } = this.settings();
    if (kubeconfig) return kubeconfig;
    const credentials = process.env.CREDENTIALS_DIRECTORY;
    if (!credentials) throw new Error("No kubeconfig for the cluster: set executor.vm.kube.kubeconfig, or give the host's service a kubeconfig credential");
    return join(credentials, "kubeconfig");
  }

  /** Runs kubectl in the namespace with `input` on its standard input, returning its output. */
  private kubectl(args: string[], input = ""): Promise<string> {
    const full = ["--kubeconfig", this.kubeconfig(), "--namespace", this.settings().namespace, "--request-timeout=30s", ...args];
    return new Promise((resolve, reject) => {
      const child = execFile(this.command, full, { maxBuffer: 16 * 1024 * 1024, timeout: 90_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`kubectl ${args.slice(0, 2).join(" ")}: ${String(stderr).trim() || error.message}`));
        else resolve(String(stdout));
      });
      child.stdin?.end(input);
    });
  }

  async start(index: number, pod: string, ticketId: string, token: string): Promise<void> {
    const settings = this.settings();
    const image = settings.image || process.env.SWARM_TICKET_RUNNER_IMAGE;
    if (!image) throw new Error("No runner image for the cluster: set executor.vm.kube.image, or SWARM_TICKET_RUNNER_IMAGE");
    const claim = volumeName(ticketId), name = pod;
    const labels = { "app.kubernetes.io/name": APP, [SLOT]: String(index), [TICKET]: ticketId };
    const memory = `${settings.memoryMiB + QEMU_MIB}Mi`;
    const env = { SWARM_GATEWAY: `http://${TUNNEL}.${settings.namespace}.svc.cluster.local:${settings.port + index}`, CPUS: String(settings.cpu),
      MEM: String(settings.memoryMiB), DISK_GIB: String(settings.diskGiB), TMPDIR: "/run/vm" };
    // The volume, as it is if the ticket booted before, and the pod, in one call.
    await this.kubectl(["apply", "--server-side", "--field-manager=swarm", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: [
      {
        apiVersion: "v1", kind: "PersistentVolumeClaim",
        metadata: { name: claim, labels: { [TICKET]: ticketId } },
        spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: `${volumeGiB(settings.diskGiB)}Gi` } } }
      },
      {
        apiVersion: "v1", kind: "Pod",
        // The autoscaler moves no running VM to empty a node: it waits until the ticket's turn ends.
        metadata: { name, labels, annotations: { "cluster-autoscaler.kubernetes.io/safe-to-evict": "false" } },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 10,
          tolerations: [{ key: TICKET_NODES, operator: "Exists", effect: "NoSchedule" }],
          securityContext: { runAsNonRoot: true, runAsUser: RUNNER_USER, runAsGroup: RUNNER_USER, fsGroup: RUNNER_USER, supplementalGroups: [KVM_GROUP],
            seccompProfile: { type: "RuntimeDefault" } },
          containers: [{
            name: "vm", image, imagePullPolicy: "IfNotPresent",
            env: Object.entries(env).map(([key, value]) => ({ name: key, value })),
            resources: {
              requests: { cpu: String(settings.cpu), memory, "ephemeral-storage": "2Gi", [KVM]: "1" },
              limits: { memory, "ephemeral-storage": "12Gi", [KVM]: "1" }
            },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            volumeMounts: [
              { name: "token", mountPath: "/run/swarm", readOnly: true },
              { name: "disk", mountPath: "/disk" },
              { name: "run", mountPath: "/run/vm" }
            ]
          }],
          volumes: [
            { name: "token", secret: { secretName: name, defaultMode: 0o440 } },
            { name: "disk", persistentVolumeClaim: { claimName: claim } },
            { name: "run", emptyDir: { sizeLimit: "10Gi" } }
          ]
        }
      }
    ] }));
    await this.scheduled(name);
    // Read after the pod got its node, so the policy keeps it from that node's address too.
    await this.guard(true);
    await this.kubectl(["create", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "Secret", metadata: { name, labels }, type: "Opaque", stringData: { token } }));
  }

  /** Waits for a pod to get its node. */
  private async scheduled(name: string): Promise<void> {
    for (const until = Date.now() + SCHEDULE_MS; ;) {
      const [found, node] = (await this.kubectl(["get", "pod", name, "--ignore-not-found", "-o", "jsonpath={.metadata.name}/{.spec.nodeName}"])).trim().split("/");
      if (!found) throw new Error(`Its pod ${name} was deleted before it got a node`);
      if (node) return;
      if (Date.now() > until) throw new Error(`Its pod ${name} got no node in ${SCHEDULE_MS / 60_000} minutes`);
      await sleep(this.pollMs);
    }
  }

  async stop(pod: string): Promise<void> {
    await this.kubectl(["delete", "pod,secret", pod, "--ignore-not-found", "--wait=false"]);
  }

  async discard(ticketId: string): Promise<void> {
    await this.kubectl(["delete", "pvc", volumeName(ticketId), "--ignore-not-found", "--wait=false"]);
  }

  /** With `fresh`, one that reads the nodes after this call, rather than one already reading them. */
  async guard(fresh = false): Promise<void> {
    if (fresh) await this.guarding?.catch(() => {});
    this.guarding ??= this.updateEgress().finally(() => { this.guarding = undefined; });
    return this.guarding;
  }

  /**
   * Replaces the nodes' addresses in the except list of the egress policy's internet rule with the current ones. The
   * annotation names the ones this host added, so the deployment's own entries stay.
   */
  private async updateEgress(): Promise<void> {
    const nodes = JSON.parse(await this.kubectl(["get", "nodes", "-o", "json"])) as { items: { status?: { addresses?: { type: string; address: string }[] } }[] };
    const current = [...new Set(nodes.items.flatMap((node) => node.status?.addresses ?? [])
      .filter((address) => address.type === "ExternalIP" && /^\d+\.\d+\.\d+\.\d+$/.test(address.address)).map((address) => `${address.address}/32`))].sort();
    const policy = JSON.parse(await this.kubectl(["get", "networkpolicy", EGRESS, "-o", "json"])) as Policy;
    const block = policy.spec.egress?.flatMap((rule) => rule.to ?? []).find((peer) => peer.ipBlock?.cidr === "0.0.0.0/0")?.ipBlock;
    if (!block) throw new Error(`The network policy ${EGRESS} has no rule for 0.0.0.0/0`);
    const added = (policy.metadata.annotations?.[NODES] ?? "").split(",").filter(Boolean);
    const own = (block.except ?? []).filter((cidr) => !added.includes(cidr));
    const ours = current.filter((cidr) => !own.includes(cidr)), next = [...own, ...ours];
    // The list itself, not only the annotation: applying the deployment's manifest again puts back its own list.
    if (next.join(",") === (block.except ?? []).join(",") && ours.join(",") === added.join(",")) return;
    block.except = next;
    policy.metadata.annotations = { ...policy.metadata.annotations, [NODES]: ours.join(",") };
    // The policy as read, resourceVersion and all: a change made since fails this replace, and the next guard reads it again.
    await this.kubectl(["replace", "-f", "-"], JSON.stringify(policy));
  }
}
