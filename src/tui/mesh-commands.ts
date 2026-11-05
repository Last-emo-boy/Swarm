/**
 * The TUI's mesh commands: `/mesh` shows this device's swarm and how each member is reached, `/mesh invite` opens a pairing
 * code that other devices join with while the TUI runs, and `/mesh join <code>` joins another device's swarm.
 */
import type { Invitation } from "../mesh/pair.js";

export interface MeshCommandResult { brief: string; detail?: string }

const USAGE = [
  "/mesh                      This device's swarm: each member and how it is reached",
  "/mesh invite               Open a pairing code; every device that joins with it joins this swarm",
  "/mesh invite stop          Close the open code",
  "/mesh join <code>          Join the swarm of the device that showed the code"
].join("\n");

export class TuiMesh {
  private invitation?: Invitation;

  /** `notify` puts a line in the transcript when a device joins, or the open code ends, after the command returned. */
  constructor(private readonly options: { meshHome?: string; notify: (brief: string) => void }) {}

  async run(args: string[]): Promise<MeshCommandResult> {
    const [first, ...rest] = args;
    if (!first) return this.status();
    if (first === "help") return { brief: "Mesh commands.", detail: USAGE };
    if (first === "invite") return rest[0] === "stop" ? this.stopInvite() : this.invite();
    if (first === "join") {
      const code = rest.join(" ").trim();
      if (!code) throw new Error("Usage: /mesh join <code>");
      return this.join(code);
    }
    throw new Error(`Unknown mesh command "${first}".\n${USAGE}`);
  }

  close(): void {
    this.invitation?.close();
    this.invitation = undefined;
  }

  private async status(): Promise<MeshCommandResult> {
    const { meshPeers, readMesh, relayOf } = await import("../mesh/state.js");
    if (!meshPeers(this.options.meshHome).length) return { brief: "This device is in no swarm yet. /mesh invite shows a code other devices join with; /mesh join <code> joins one.", detail: USAGE };
    const { peerHealth } = await import("../mesh/client.js");
    const health = await peerHealth(this.options.meshHome, 5000);
    const { node } = readMesh(this.options.meshHome);
    const reached = health.filter((item) => item.reachable).length;
    return {
      brief: `${node.name}'s swarm: ${health.length} other ${health.length === 1 ? "device" : "devices"}, ${reached} reachable now.`,
      detail: [...health.map((item) => `${item.peer.name.padEnd(16)} ${item.reachable ? `${item.path}, ${item.ms} ms` : `unreachable: ${item.error}`}`),
        "", `Relay: ${relayOf(node) ?? "off"}`].join("\n")
    };
  }

  private async invite(): Promise<MeshCommandResult> {
    if (this.invitation) return { brief: `Pairing code ${this.invitation.code} is open until ${this.invitation.expiresAt.toLocaleTimeString()}. /mesh invite stop closes it.` };
    const { inviteWithCode } = await import("../mesh/pair.js");
    const invitation = await inviteWithCode({
      ...(this.options.meshHome ? { home: this.options.meshHome } : {}),
      onJoin: (peer) => this.options.notify(`${peer.name} joined your swarm.`),
      onRefused: (left) => this.options.notify(`Someone tried a wrong pairing code; ${left} more wrong ${left === 1 ? "try closes" : "tries close"} it.`)
    });
    this.invitation = invitation;
    void invitation.ended.then((reason) => {
      if (this.invitation !== invitation) return;
      this.invitation = undefined;
      this.options.notify(`Pairing code ${invitation.code} closed: ${reason}.`);
    });
    return {
      brief: `Pairing code: ${invitation.code}. On each device to add, run swarm mesh join ${invitation.code} or /mesh join ${invitation.code}.`,
      detail: `The code stays open for 15 minutes while this TUI runs, for any number of devices; each one is paired with every member of this swarm.\n/mesh invite stop closes it sooner.`
    };
  }

  private stopInvite(): MeshCommandResult {
    const invitation = this.invitation;
    if (!invitation) return { brief: "No pairing code is open." };
    this.invitation = undefined;
    invitation.close();
    return { brief: `Closed pairing code ${invitation.code}.` };
  }

  private async join(code: string): Promise<MeshCommandResult> {
    const { joinWithCode } = await import("../mesh/pair.js");
    const { peerHealth } = await import("../mesh/client.js");
    const { inviter, members } = await joinWithCode(code, this.options.meshHome);
    const health = await peerHealth(this.options.meshHome, 10_000);
    return {
      brief: `Joined ${inviter.name}'s swarm${members.length ? `, with ${members.map((member) => member.name).join(", ")}` : ""}. Their tickets now show beside yours.`,
      detail: health.map((item) => `${item.peer.name.padEnd(16)} ${item.reachable ? item.path : `not reachable now; it links up once both are online (${item.error})`}`).join("\n")
    };
  }
}
