/**
 * The cluster ticket VMs' control against a fake kubectl, which records each call with its standard input and answers
 * with the nodes and the egress policy of a cluster.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { KubeControl, podName } from "./kube-control.js";

let dir: string;
const FAKE = `#!/bin/sh
dir=$(dirname "$0")
n=$(ls "$dir/calls" | wc -l | tr -d ' ')
printf '%s\\n' "$*" > "$dir/calls/$(printf %03d "$n").args"
cat > "$dir/calls/$(printf %03d "$n").in"
case "$*" in
  *"get nodes"*) cat "$dir/nodes.json" ;;
  *"get networkpolicy"*) cat "$dir/policy.json" ;;
  *" get pod "*) pod=$(printf '%s\n' "$*" | sed -n 's/.* get pod \\([^ ]*\\) .*/\\1/p')
    if [ -f "$dir/gone" ]; then :; elif [ -f "$dir/unscheduled" ]; then rm "$dir/unscheduled"; printf '%s/' "$pod"; else printf '%s/node-0' "$pod"; fi ;;
  *"replace -f -"*) cp "$dir/calls/$(printf %03d "$n").in" "$dir/policy.json" ;;
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
  image: "ghcr.io/x/runner:1", cpu: 3, memoryMiB: 6144, diskGiB: 20 }), join(dir, "kubectl"), 10);

test("a cluster slot boots its ticket in a pod of its own with the ticket's volume, and its token once its node is kept out of reach", async () => {
  const kube = control();
  const name = podName(3);
  assert.match(name, /^swarm-ticket-3-[0-9a-f]{6}$/);
  // The cluster has not placed the pod at first, as while it adds a node.
  writeFileSync(join(dir, "unscheduled"), "");
  await kube.start(3, name, "a".repeat(32), "slot-token");
  const first = calls();
  assert.deepEqual(first.map((call) => call.args), [
    "apply --server-side --field-manager=swarm -f -",
    `get pod ${name} --ignore-not-found -o jsonpath={.metadata.name}/{.spec.nodeName}`,
    `get pod ${name} --ignore-not-found -o jsonpath={.metadata.name}/{.spec.nodeName}`,
    "get nodes -o json", "get networkpolicy swarm-ticket-egress -o json", "replace -f -",
    "create -f -"
  ]);
  const [volume, pod] = (JSON.parse(first[0]!.input) as { items: [Record<string, any>, Record<string, any>] }).items;
  assert.equal(volume.kind, "PersistentVolumeClaim");
  assert.equal(volume.spec.resources.requests.storage, "23Gi");
  const secret = JSON.parse(first[6]!.input) as Record<string, any>;
  assert.equal(secret.stringData.token, "slot-token");
  assert.equal(pod.metadata.name, name);
  assert.equal(secret.metadata.name, name);
  assert.deepEqual(pod.metadata.labels, { "app.kubernetes.io/name": "swarm-ticket", "swarm.w33d.xyz/slot": "3", "swarm.w33d.xyz/ticket": "a".repeat(32) });
  const container = pod.spec.containers[0];
  assert.equal(container.image, "ghcr.io/x/runner:1");
  assert.deepEqual(container.env.find((item: { name: string }) => item.name === "SWARM_GATEWAY"),
    { name: "SWARM_GATEWAY", value: "http://swarm-tunnel.swarm-tickets.svc.cluster.local:47203" });
  assert.equal(container.resources.limits["swarm.w33d.xyz/kvm"], "1");
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.deepEqual(pod.spec.tolerations, [{ key: "swarm.w33d.xyz/tickets", operator: "Exists", effect: "NoSchedule" }], "it may run on the nodes kept for tickets");
  assert.equal(pod.spec.volumes.find((item: { name: string }) => item.name === "disk").persistentVolumeClaim.claimName, `swarm-ticket-${"a".repeat(32)}`);
  // A boot's pod and Secret go on stop, by name, and the ticket's volume on discard.
  await kube.stop(name);
  await kube.discard("a".repeat(32));
  assert.deepEqual(calls().map((call) => call.args), [`delete pod,secret ${name} --ignore-not-found --wait=false`,
    `delete pvc swarm-ticket-${"a".repeat(32)} --ignore-not-found --wait=false`]);
  // A pod deleted before it got a node ends its boot without a token.
  writeFileSync(join(dir, "unscheduled"), "");
  const kept = kube.start(3, podName(3), "a".repeat(32), "t");
  writeFileSync(join(dir, "gone"), "");
  await assert.rejects(kept, /was deleted before it got a node/);
  assert.ok(!calls().some((call) => call.args === "create -f -"));
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
  // The deployment applied its manifest again, which put back its own list but kept the annotation.
  writeFileSync(join(dir, "policy.json"), policy(["10.0.0.0/8", "15.204.105.214/32"], { "swarm.w33d.xyz/nodes": "135.148.170.16/32,51.81.1.2/32" }));
  await kube.guard();
  assert.deepEqual(except().spec.egress[1]!.to[0]!.ipBlock!.except, ["10.0.0.0/8", "15.204.105.214/32", "135.148.170.16/32", "51.81.1.2/32"]);
  // Two guards at once read the cluster once; a fresh one reads it again after the one in flight.
  calls();
  writeFileSync(join(dir, "nodes.json"), nodes("135.148.170.16"));
  await Promise.all([kube.guard(), kube.guard()]);
  assert.equal(calls().filter((call) => call.args === "get nodes -o json").length, 1);
  await Promise.all([kube.guard(), kube.guard(true)]);
  assert.equal(calls().filter((call) => call.args === "get nodes -o json").length, 2);
});

test("without a kubeconfig or a runner image the control says what to set", async () => {
  const saved = process.env.CREDENTIALS_DIRECTORY;
  delete process.env.CREDENTIALS_DIRECTORY;
  try {
    const kube = new KubeControl(() => ({ kubeconfig: "", namespace: "swarm-tickets", slots: 10, port: 47_200, image: "", cpu: 3, memoryMiB: 6144, diskGiB: 20 }), join(dir, "kubectl"));
    await assert.rejects(kube.stop("swarm-ticket-0-abcdef"), /set executor\.vm\.kube\.kubeconfig/);
    process.env.CREDENTIALS_DIRECTORY = dir;
    await assert.rejects(kube.start(0, podName(0), "a".repeat(32), "t"), /No runner image/);
  } finally {
    if (saved === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = saved;
  }
});
