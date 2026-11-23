/**
 * The control socket a running node answers on: `swarm mesh invite` asks it to open a pairing code, so a code no longer
 * needs a foreground process, and the node keeps it open for its minutes. A Unix socket in the mesh home, readable by its
 * owner alone, answering JSON over HTTP: `POST /v1/invite {"minutes":N}` and `GET /v1/health`.
 */
import { chmodSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod/v4";
import { inviteWithCode, type Invitation } from "./pair.js";

/** The socket's file name inside the mesh home. */
export const ADMIN_SOCKET = "admin.sock";
export const adminSocket = (home: string): string => join(home, ADMIN_SOCKET);

/** A code a node opened: what `swarm mesh invite` prints. */
export interface AdminCode { code: string; expiresAt: string }

export interface MeshAdminOptions {
  home: string;
  log?: (message: string) => void;
  /** Opens a code; the node's own mailbox, or a test's stand-in. */
  open?: (minutes: number) => Promise<Invitation>;
}
const InviteBody = z.object({ minutes: z.number().int().min(1).max(60) });

export class MeshAdmin {
  private server?: Server;
  /** The code this node keeps open: a second ask gets the same one while it lasts. */
  private invite?: AdminCode & { close: () => void };
  constructor(private readonly options: MeshAdminOptions) {}

  get socket(): string { return adminSocket(this.options.home); }

  async start(): Promise<void> {
    const socket = this.socket;
    rmSync(socket, { force: true });
    const server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => { server.off("error", reject); resolve(); });
    });
    // Only this user's processes may ask the node for a code, as only they could run `swarm mesh invite` themselves.
    chmodSync(socket, 0o600);
    this.server = server;
  }

  async stop(): Promise<void> {
    this.invite?.close();
    this.invite = undefined;
    const server = this.server;
    this.server = undefined;
    rmSync(this.socket, { force: true });
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const path = (request.url ?? "/").split("?")[0];
      if (request.method === "GET" && path === "/v1/health") return send(200, { ok: true });
      if (request.method === "POST" && path === "/v1/invite") {
        const { minutes } = InviteBody.parse(await readJson(request));
        return send(200, await this.open(minutes));
      }
      send(404, { error: "Unknown control command" });
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Opens a code, or hands back the live one: asking twice within its minutes must not cancel the first. */
  private async open(minutes: number): Promise<AdminCode> {
    if (this.invite && Date.parse(this.invite.expiresAt) > Date.now()) return { code: this.invite.code, expiresAt: this.invite.expiresAt };
    this.invite?.close();
    const open = this.options.open ?? ((mins: number) => inviteWithCode({ home: this.options.home, minutes: mins,
      onJoin: (peer) => this.options.log?.(`mesh: ${peer.name} joined`),
      onRefused: (left) => this.options.log?.(`mesh: a wrong code; ${left} more cancels the invite`),
      log: this.options.log }));
    const invitation = await open(minutes);
    const opened = { code: invitation.code, expiresAt: invitation.expiresAt.toISOString(), close: invitation.close };
    this.invite = opened;
    void invitation.ended.then((reason) => {
      if (this.invite?.code === opened.code) this.invite = undefined;
      this.options.log?.(`mesh: the invite ${reason}`);
    });
    return { code: opened.code, expiresAt: opened.expiresAt };
  }
}

/** What a running node here answers, or undefined when none does. */
export async function askAdmin(home: string, minutes: number): Promise<AdminCode | undefined> {
  return await new Promise<AdminCode | undefined>((resolve) => {
    const body = JSON.stringify({ minutes });
    const request = httpRequest({ socketPath: adminSocket(home), path: "/v1/invite", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 5000 }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => {
        try {
          const answer = JSON.parse(text) as Partial<AdminCode> & { error?: string };
          resolve(response.statusCode === 200 && typeof answer.code === "string" && typeof answer.expiresAt === "string"
            ? { code: answer.code, expiresAt: answer.expiresAt } : undefined);
        } catch { resolve(undefined); }
      });
    });
    request.once("timeout", () => { request.destroy(); resolve(undefined); });
    request.once("error", () => resolve(undefined));
    request.end(body);
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let text = "";
  request.setEncoding("utf8");
  for await (const chunk of request) text += chunk as string;
  return JSON.parse(text || "{}");
}
