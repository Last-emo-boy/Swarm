import type { IncomingHttpHeaders } from "node:http";

export const GATEWAY_LOCAL_CONTROL_HEADER = "x-swarm-local-control";
export const GATEWAY_TOKEN_HEADER = "x-swarm-gateway-token";

export type GatewaySecurityOptions = {
  authToken?: string;
  allowRemote?: boolean;
  allowedOrigins?: string[];
};

export type GatewayAuthInput = {
  method?: string;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  remoteAddress?: string;
};

export type GatewayDecision =
  | { ok: true }
  | { ok: false; status: number; message: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1",
  "http://localhost",
  "http://[::1]",
  "https://127.0.0.1",
  "https://localhost",
  "https://[::1]"
];

export function gatewayClientAuthHeaders(): Record<string, string> {
  const token = normalizedToken(process.env.SWARM_GATEWAY_TOKEN);
  if (token) {
    return { authorization: `Bearer ${token}` };
  }
  return { [GATEWAY_LOCAL_CONTROL_HEADER]: "1" };
}

export function validateGatewayBindHost(host: string | undefined, options: GatewaySecurityOptions = {}): GatewayDecision {
  const normalized = normalizeHost(host);
  if (isLoopbackHost(normalized)) {
    return { ok: true };
  }
  if (options.allowRemote === true && normalizedToken(options.authToken)) {
    return { ok: true };
  }
  const remoteHint = WILDCARD_HOSTS.has(normalized)
    ? "wildcard"
    : "non-loopback";
  return {
    ok: false,
    status: 403,
    message: `Refusing to bind Swarm Gateway to ${remoteHint} host ${host ?? "(empty)"}. Use 127.0.0.1, or set SWARM_GATEWAY_ALLOW_REMOTE=1 with SWARM_GATEWAY_TOKEN for remote binding.`
  };
}

export function authorizeGatewayRequest(input: GatewayAuthInput, options: GatewaySecurityOptions = {}): GatewayDecision {
  const method = (input.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { ok: true };
  }
  const expectedToken = normalizedToken(options.authToken);
  if (expectedToken && requestToken(input.headers) === expectedToken) {
    return { ok: true };
  }
  const localControl = headerValue(input.headers, GATEWAY_LOCAL_CONTROL_HEADER);
  if (localControl === "1" && isLoopbackAddress(input.remoteAddress)) {
    return { ok: true };
  }
  return {
    ok: false,
    status: expectedToken ? 401 : 403,
    message: expectedToken
      ? "Gateway mutation requires a valid Authorization bearer token or X-Swarm-Gateway-Token."
      : "Gateway mutation requires X-Swarm-Local-Control from a loopback client or SWARM_GATEWAY_TOKEN authentication."
  };
}

export function gatewayCorsDecision(origin: string | undefined, options: GatewaySecurityOptions = {}): GatewayDecision {
  if (!origin) {
    return { ok: true };
  }
  const allowed = options.allowedOrigins?.length
    ? options.allowedOrigins
    : DEFAULT_ALLOWED_ORIGINS;
  if (allowed.includes("*") || allowed.includes(origin) || allowedOriginPrefix(origin, allowed)) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    message: `Origin is not allowed by Swarm Gateway CORS policy: ${origin}`
  };
}

export function corsResponseHeaders(origin: string | undefined, options: GatewaySecurityOptions = {}): Record<string, string> {
  const decision = gatewayCorsDecision(origin, options);
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Swarm-Gateway-Token, X-Swarm-Local-Control"
  };
  if (origin && decision.ok) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function parseGatewayAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function requestToken(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>): string | undefined {
  const explicit = headerValue(headers, GATEWAY_TOKEN_HEADER);
  if (explicit) {
    return explicit;
  }
  const authorization = headerValue(headers, "authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return normalizedToken(match?.[1]);
}

function allowedOriginPrefix(origin: string, allowed: string[]): boolean {
  try {
    const parsed = new URL(origin);
    const base = `${parsed.protocol}//${parsed.hostname}`;
    return allowed.includes(base) && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function headerValue(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() ? first.trim() : undefined;
}

function normalizedToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token && token.length >= 8 ? token : undefined;
}

function normalizeHost(host: string | undefined): string {
  return (host ?? "127.0.0.1").trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const normalized = address.replace(/^::ffff:/, "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.");
}
