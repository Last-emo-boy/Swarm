import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewaySecurityOptions } from "./gateway-auth.js";
import { corsResponseHeaders } from "./gateway-auth.js";

const MAX_JSON_BODY_BYTES = 1_000_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

export function integerParam(url: URL, key: string, fallback: number): number {
  const parsed = Number(url.searchParams.get(key));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 500) : fallback;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function setCommonHeaders(
  response: ServerResponse,
  origin: string | undefined,
  security: GatewaySecurityOptions = {}
): void {
  for (const [key, value] of Object.entries(corsResponseHeaders(origin, security))) {
    response.setHeader(key, value);
  }
}

export function optionalHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() ? first.trim() : undefined;
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeSse(response: ServerResponse, id: number, eventName: string, value: unknown): void {
  response.write(`id: ${id}\n`);
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
