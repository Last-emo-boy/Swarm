import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { nodeCard } from "../mesh/card.js";
import { joinMesh } from "../mesh/client.js";
import { lendFolders, registerLending } from "../mesh/lend.js";
import { MeshServer } from "../mesh/server.js";
import { createInvite, readMesh, setGrant, updateMesh } from "../mesh/state.js";
import type { SwarmRuntime } from "../runtime/runtime.js";

// These nodes link up directly; none of them may reach out to a real relay.
process.env.SWARM_MESH_RELAY = "off";

const root = realpathSync(mkdtempSync(join(tmpdir(), "swarm-worker-borrow-")));
const runtimes: SwarmRuntime[] = [];
let lender: MeshServer;

/** A directory under the test's root. */
function dir(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

before(async () => {
  // `gpu` lends a shell to `mac`, which holds the operator grant there, as src/mesh/lend.test.ts pairs them.
  const home = join(root, "gpu-mesh");
  updateMesh((state) => ({ ...state, node: { ...state.node, name: "gpu", listen: "127.0.0.1:0" } }), home);
  lender = new MeshServer({ home, card: () => nodeCard(readMesh(home).node, { abilities: ["test"] }) });
  registerLending(lender);
  const { address: url } = await lender.start();
  updateMesh((state) => ({ ...state, node: { ...state.node, advertise: url } }), home);
  lendFolders("shell", [dir("gpu-work")], home);
  const macHome = join(root, "mac-mesh");
  updateMesh((state) => ({ ...state, node: { ...state.node, name: "mac", advertise: "http://127.0.0.1:9" } }), macHome);
  await joinMesh(createInvite(url, 15, home), macHome);
  setGrant("mac", "operator", home);
  // The worker runs on a host that is this mesh node, with the host's own Swarm and mesh homes.
  process.env.SWARM_HOME = join(root, "swarm-home");
  process.env.SWARM_MESH_HOME = macHome;
});

after(async () => {
  for (const runtime of runtimes) runtime.dispose();
  await lender.stop();
  rmSync(root, { recursive: true, force: true });
});

const lentTools = async (runtime: SwarmRuntime) =>
  (await runtime.listCapabilities({ includeDisabled: true })).map((item) => item.name).filter((name) => name.startsWith("mcp__gpu__"));

test("a ticket worker's runtime on a mesh node offers none of the tools paired nodes lend, also after a lender change", async () => {
  const { SwarmRuntime } = await import("../runtime/runtime.js");
  const session = new SwarmRuntime({ workspace: dir("session-work"), databasePath: join(root, "session.db") });
  runtimes.push(session);
  assert.ok((await lentTools(session)).includes("mcp__gpu__shell"), "a session on the same node borrows gpu's shell");

  const { workerRuntime } = await import("./worker.js");
  // Ticket tools that exit at once: what the worker borrows does not depend on them.
  const worker = await workerRuntime(dir("ticket-dir"), [process.execPath, "-e", "process.exit(0)"], { args: [], env: {} });
  runtimes.push(worker);
  assert.deepEqual(await lentTools(worker), [], "the worker reaches gpu only through its ticket mesh tool");
  // A lender change loads the borrowed servers again, and so does a full refresh: neither brings them into the worker.
  await worker.capabilityPlane.refreshBorrowedMcp();
  await worker.capabilityPlane.refresh("mcp");
  assert.deepEqual(await lentTools(worker), []);
  assert.deepEqual(worker.listMcpServers().map((server) => server.id), ["ticket"]);
});
