import { strict as assert } from "node:assert";
import test from "node:test";
import {
  authorizeGatewayRequest,
  corsResponseHeaders,
  gatewayCorsDecision,
  gatewayClientAuthHeaders,
  validateGatewayBindHost
} from "./gateway-auth.js";

test("validateGatewayBindHost allows loopback and blocks remote bind without token", () => {
  assert.equal(validateGatewayBindHost("127.0.0.1").ok, true);
  assert.equal(validateGatewayBindHost("localhost").ok, true);
  assert.equal(validateGatewayBindHost("0.0.0.0").ok, false);
  assert.equal(validateGatewayBindHost("0.0.0.0", { allowRemote: true, authToken: "long-enough-token" }).ok, true);
});

test("authorizeGatewayRequest protects mutating routes", () => {
  assert.equal(authorizeGatewayRequest({ method: "GET", headers: {} }).ok, true);
  assert.equal(authorizeGatewayRequest({ method: "POST", headers: {}, remoteAddress: "127.0.0.1" }).ok, false);
  assert.equal(authorizeGatewayRequest({
    method: "POST",
    headers: { "x-swarm-local-control": "1" },
    remoteAddress: "127.0.0.1"
  }).ok, true);
  assert.equal(authorizeGatewayRequest({
    method: "POST",
    headers: { authorization: "Bearer long-enough-token" },
    remoteAddress: "203.0.113.4"
  }, { authToken: "long-enough-token" }).ok, true);
});

test("gateway CORS defaults to loopback origins only", () => {
  assert.equal(gatewayCorsDecision(undefined).ok, true);
  assert.equal(gatewayCorsDecision("http://127.0.0.1:38171").ok, true);
  assert.equal(gatewayCorsDecision("https://example.com").ok, false);
  assert.equal(gatewayCorsDecision("https://example.com", { allowedOrigins: ["https://example.com"] }).ok, true);

  const headers = corsResponseHeaders("http://localhost:38171");
  assert.equal(headers["Access-Control-Allow-Origin"], "http://localhost:38171");
  assert(headers["Access-Control-Allow-Headers"].includes("X-Swarm-Local-Control"));
});

test("gatewayClientAuthHeaders sends token auth when configured", () => {
  const oldToken = process.env.SWARM_GATEWAY_TOKEN;
  try {
    delete process.env.SWARM_GATEWAY_TOKEN;
    assert.deepEqual(gatewayClientAuthHeaders(), { "x-swarm-local-control": "1" });
    process.env.SWARM_GATEWAY_TOKEN = "long-enough-token";
    assert.deepEqual(gatewayClientAuthHeaders(), { authorization: "Bearer long-enough-token" });
  } finally {
    if (oldToken === undefined) {
      delete process.env.SWARM_GATEWAY_TOKEN;
    } else {
      process.env.SWARM_GATEWAY_TOKEN = oldToken;
    }
  }
});
