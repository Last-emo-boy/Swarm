/**
 * The cluster ticket VMs' control against a fake kubectl, which records each call with its standard input and answers
 * with the nodes and the egress policy of a cluster.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { KubeControl } from "./kube-control.js";

let dir: string;
const FAKE = `#!/bin/sh
dir=$(dirname "$0")
n=$(ls "$dir/calls" | wc -l | tr -d ' ')
printf '%s\\n' "$*" > "$dir/calls/$(printf %03d "$n").args"
cat > "$dir/calls/$(printf %03d "$n").in"
case "$*" in
  *"get nodes"*) cat "$dir/nodes.json" ;;
  *"get networkpolicy"*) cat "$dir/policy.json" ;;
  *"get pvc"*) [ ! -f "$dir/pvc" ] || echo persistentvolumeclaim/x ;;
  *"replace -f -"*) cp "$dir/calls/$(printf %03d "$n").in" "$dir/policy.json" ;;
  *"create -f -"*) ! grep -q PersistentVolumeClaim "$dir/calls/$(printf %03d "$n").in" || touch "$dir/pvc" ;;
esac
`;
const nodes = (...ips: string[]) => JSON.stringify({ items: ips.map((ip, n) => ({ status: { addresses: [
  { type: "InternalIP", address: `10.1.1.${n + 2}` }, { type: "ExternalIP", address: ip }, { type: "Hostname", address: `node-${n}` }] } })) });
const policy = (except: string[], annotations?: Record<string, string>) => JSON.stringify({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy",
  metadata: { name: "swarm-ticket-egress", resourceVersion: "7", ...annotations ? { annotations } : {} },
  spec: { egress: [{ to: [{ namespaceSelector: {} }], ports: [{ port: 53 }] }, { to: [{ ipBlock: { cidr: "0.0.0.0/0", except } }] }] } });

/** The calls kubectl got since the last read, without the kubeconfig, namespace and timeout every call has. */
function calls(): { args: string; input: string }[] {
  const files = readdirSync(join(dir, "calls")).filter((file) => file.endsWith(".args")).sort();
  const result = files.map((file) => ({ args: readFileSync(join(dir, "calls", file), "utf8").trim().replace(/^--kubeconfig \S+ --namespace swarm-tickets --request-timeout=30s /, ""),
    input: readFileSync(join(dir, "calls", file.replace(".args", ".in")), "utf8") }));
  rmSync(join(dir, "calls"), { recursive: true });
  mkdirSync(join(dir, "calls"));
  return result;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-kube-"));
  mkdirSync(join(dir, "calls"));
  writeFileSync(join(dir, "kubectl"), FAKE);
  chmodSync(join(dir, "kubectl"), 0o755);
  writeFileSync(join(dir, "nodes.json"), nodes("40.160.69.5"));
  writeFileSync(join(dir, "policy.json"), policy(["10.0.0.0/8", "15.204.105.214/32"]));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const control = () => new KubeControl(() => ({ kubeconfig: join(dir, "config"), namespace: "swarm-tickets", slots: 10, port: 47_200,
  image: "ghcr.io/x/runner:1", cpu: 3, memoryMiB: 6144, diskGiB: 20 }), join(dir, "kubectl"));

test("a cluster slot boots its ticket in a pod of its own, with the ticket's volume made once and the slot's token in a Secret", async () => {
  const kube = control();
  await kube.start(3, "a".repeat(32), "slot-token");
  const first = calls();
  assert.deepEqual(first.map((call) => call.args), [
    "delete pod,secret -l swarm.w33d.xyz/slot=3 --ignore-not-found --wait=false",
    "get nodes -o json", "get networkpolicy swarm-ticket-egress -o json", "replace -f -",
    `get pvc swarm-ticket-${"a".repeat(32)} --ignore-not-found -o name`, "create -f -", "create -f -"
  ]);
  const volume = JSON.parse(first[5]!.input) as { spec: { resources: { requests: { storage: string } } } };
  assert.equal(volume.spec.resources.requests.storage, "23Gi");
  const [secret, pod] = (JSON.parse(first[6]!.input) as { items: [Record<string, any>, Record<string, any>] }).items;
  assert.equal(secret.stringData.token, "slot-token");
  assert.equal(pod.metadata.name, secret.metadata.name);
  assert.match(pod.metadata.name, /^swarm-ticket-3-[0-9a-f]{6}$/);
  assert.deepEqual(pod.metadata.labels, { "app.kubernetes.io/name": "swarm-ticket", "swarm.w33d.xyz/slot": "3", "swarm.w33d.xyz/ticket": "a".repeat(32) });
  const container = pod.spec.containers[0];
  assert.equal(container.image, "ghcr.io/x/runner:1");
  assert.deepEqual(container.env.find((item: { name: string }) => item.name === "SWARM_GATEWAY"),
    { name: "SWARM_GATEWAY", value: "http://swarm-tunnel.swarm-tickets.svc.cluster.local:47203" });
  assert.equal(container.resources.limits["swarm.w33d.xyz/kvm"], "1");
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.volumes.find((item: { name: string }) => item.name === "disk").persistentVolumeClaim.claimName, `swarm-ticket-${"a".repeat(32)}`);
  // Booted again, it keeps its volume; the slot's pod and Secret go on stop, and its volume on discard.
  await kube.start(3, "a".repeat(32), "next-token");
  assert.equal(calls().filter((call) => call.args === "create -f -").length, 1);
  await kube.stop(3);
  await kube.discard("a".repeat(32));
  assert.deepEqual(calls().map((call) => call.args), ["delete pod,secret -l swarm.w33d.xyz/slot=3 --ignore-not-found --wait=false",
    `delete pvc swarm-ticket-${"a".repeat(32)} --ignore-not-found --wait=false`]);
});

test("the egress policy keeps the deployment's own entries and follows the nodes' public addresses as they come and go", async () => {
  const kube = control();
  await kube.guard();
  const except = () => (JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")) as { metadata: { resourceVersion: string; annotations: Record<string, string> };
    spec: { egress: { to: { ipBlock?: { except: string[] } }[] }[] } });
  assert.deepEqual(except().spec.egress[1]!.to[0]!.ipBlock!.except, ["10.0.0.0/8", "15.204.105.214/32", "40.160.69.5/32"]);
  assert.equal(except().metadata.annotations["swarm.w33d.xyz/nodes"], "40.160.69.5/32");
  assert.equal(except().metadata.resourceVersion, "7", "the replace is conditional on the policy as read");
  calls();
  await kube.guard();
  assert.ok(!calls().some((call) => call.args === "replace -f -"), "nothing changed, nothing is written");
  writeFileSync(join(dir, "nodes.json"), nodes("135.148.170.16", "51.81.1.2"));
  await kube.guard();
  assert.deepEqual(except().spec.egress[1]!.to[0]!.ipBlock!.except, ["10.0.0.0/8", "15.204.105.214/32", "135.148.170.16/32", "51.81.1.2/32"]);
  // Two guards at once read the cluster once.
  calls();
  writeFileSync(join(dir, "nodes.json"), nodes("135.148.170.16"));
  await Promise.all([kube.guard(), kube.guard()]);
  assert.equal(calls().filter((call) => call.args === "get nodes -o json").length, 1);
  assert.ok(!existsSync(join(dir, "pvc")));
});

test("without a kubeconfig or a runner image the control says what to set", async () => {
  const saved = process.env.CREDENTIALS_DIRECTORY;
  delete process.env.CREDENTIALS_DIRECTORY;
  try {
    const kube = new KubeControl(() => ({ kubeconfig: "", namespace: "swarm-tickets", slots: 10, port: 47_200, image: "", cpu: 3, memoryMiB: 6144, diskGiB: 20 }), join(dir, "kubectl"));
    await assert.rejects(kube.stop(0), /set executor\.vm\.kube\.kubeconfig/);
    process.env.CREDENTIALS_DIRECTORY = dir;
    await assert.rejects(kube.start(0, "a".repeat(32), "t"), /No runner image/);
  } finally {
    if (saved === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = saved;
  }
});
