import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { RelayServer } from "../mesh/relay.js";
import { readMesh, updateMesh } from "../mesh/state.js";
import { TuiMesh } from "./mesh-commands.js";

process.env.SWARM_MESH_RELAY = "off";

const root = mkdtempSync(join(tmpdir(), "swarm-tui-mesh-"));
let relay: RelayServer;
let relayUrl: string;

before(async () => {
  relay = new RelayServer();
  relayUrl = (await relay.start("127.0.0.1:0")).url;
});
after(async () => {
  await relay.stop();
  rmSync(root, { recursive: true, force: true });
});

function device(name: string): string {
  const home = join(root, name);
  updateMesh((state) => ({ ...state, node: { ...state.node, name, listen: "127.0.0.1:0", advertise: "127.0.0.1:9", relay: relayUrl } }), home);
  return home;
}

test("/mesh invite shows a code, /mesh join on another device joins with it, and the inviting TUI hears of it", async () => {
  const notes: string[] = [];
  const mac = new TuiMesh({ meshHome: device("mac"), notify: (brief) => notes.push(brief) });
  const gpuHome = device("gpu");
  const gpu = new TuiMesh({ meshHome: gpuHome, notify: () => {} });
  try {
    assert.match((await gpu.run([])).brief, /in no swarm yet/);
    const opened = await mac.run(["invite"]);
    const code = /Pairing code: (\S+)\./.exec(opened.brief)?.[1];
    assert.ok(code, opened.brief);
    assert.match((await mac.run(["invite"])).brief, new RegExp(`${code!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is open`), "a second invite shows the open code");

    const joined = await gpu.run(["join", code!]);
    assert.match(joined.brief, /^Joined mac's swarm\./);
    assert.deepEqual(readMesh(gpuHome).peers.map((peer) => peer.name), ["mac"]);
    assert.deepEqual(notes, ["gpu joined your swarm."]);

    assert.match((await mac.run(["invite", "stop"])).brief, /^Closed pairing code/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match((await mac.run(["invite", "stop"])).brief, /No pairing code is open/);
    await assert.rejects(gpu.run(["join"]), /Usage: \/mesh join <code>/);
  } finally {
    mac.close();
    gpu.close();
  }
});
