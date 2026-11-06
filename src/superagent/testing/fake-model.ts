/**
 * A scripted OpenAI-compatible chat-completions server for end-to-end tests: every request is recorded, and `answer` turns
 * a request into the assistant's text. Worker processes reach it through a provider definition, as Swarm's smoke tests do.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSwarmSettings } from "../../config/settings.js";

export interface ModelRequest { system: string; user: string; body: Record<string, unknown> }
/** The assistant's text for a request; a promise holds the request open until it settles. */
export type Answer = (request: ModelRequest, index: number) => string | Promise<string>;

const text = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : String((part as { text?: string }).text ?? "")).join("\n") : "";

export async function startFakeModel(answer: Answer): Promise<{ url: string; requests: ModelRequest[]; close(): Promise<void>; server: Server }> {
  const requests: ModelRequest[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages?: { role: string; content: unknown }[] };
      const messages = body.messages ?? [];
      const entry = {
        system: messages.filter((message) => message.role === "system").map((message) => text(message.content)).join("\n"),
        user: messages.filter((message) => message.role !== "system").map((message) => text(message.content)).join("\n"),
        body
      };
      const index = requests.push(entry) - 1;
      void (async () => answer(entry, index))().then((content) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: `chatcmpl-${index + 1}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "model",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        }));
      }, (error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Writes a Swarm home whose every model role uses the fake model at `url`. */
export function writeFakeModelHome(home: string, url: string): void {
  mkdirSync(join(home, "state"), { recursive: true });
  mkdirSync(join(home, "logs"), { recursive: true });
  const settings = defaultSwarmSettings();
  settings.models.defaultProvider = "local-test";
  settings.models.planner = "local-test/model";
  settings.models.worker = "local-test/model";
  settings.models.aggregator = "local-test/model";
  settings.enabledProviders = ["local-test"];
  settings.runtime.databasePath = join(home, "state", "swarm.db");
  settings.providers["local-test"] = {
    id: "local-test", name: "Local Test Provider", protocol: "openai-chat-completions", baseURL: url,
    modelListProtocol: "none", apiKeyEnv: "LOCAL_TEST_API_KEY", apiKeyRequired: false, auth: "none",
    models: { model: { name: "Local Test Model" } }
  };
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  writeFileSync(join(home, "config.json"), "{}\n", "utf8");
}
