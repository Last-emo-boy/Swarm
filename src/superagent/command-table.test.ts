/**
 * The one command table (command-table.ts): the three surfaces that used to carry their own name lists now read this
 * one, so a command added here is reachable from the router's prompt, the terminal's forwarding and every chat kind at
 * once.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, COMMAND_TABLE, FORWARDED, ROUTER_COMMANDS } from "./command-table.js";
import { AGENT_COMMANDS } from "./prompts.js";

test("the router's commands are exactly the table's router rows, in table order", () => {
  assert.deepEqual([...ROUTER_COMMANDS], [...AGENT_COMMANDS]);
  assert.deepEqual([...COMMANDS], COMMAND_TABLE.map((command) => command.name));
});

test("a terminal forwards every command it has no own one for, and keeps help and memory", () => {
  assert.deepEqual([...FORWARDED], COMMAND_TABLE.filter((command) => !command.tui).map((command) => command.name));
  assert.ok(!(FORWARDED as readonly string[]).includes("help"));
  assert.ok(!(FORWARDED as readonly string[]).includes("memory"));
  assert.ok((FORWARDED as readonly string[]).includes("link"));
  assert.ok((FORWARDED as readonly string[]).includes("takeover"));
});

test("no command is listed twice and each name is a plain slash word", () => {
  assert.equal(new Set(COMMANDS).size, COMMANDS.length);
  for (const name of COMMANDS) assert.match(name, /^[a-z]+$/);
});
