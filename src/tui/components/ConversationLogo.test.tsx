import { strict as assert } from "node:assert";
import test from "node:test";
import React from "react";
import { frameText, renderTuiToFrame } from "../renderer/testing.js";
import { ConversationLogo } from "./ConversationLogo.js";

test("ConversationLogo keeps the default startup card free of setup noise", () => {
  const frame = renderTuiToFrame(React.createElement(ConversationLogo, {
    version: "0.1.0",
    cwd: "E:\\Playground\\Swarm",
    columns: 100
  }), { columns: 100, rows: 12 });
  const text = frameText(frame);

  assert.match(text, /Swarm/);
  assert.match(text, /Local workspace/);
  assert.match(text, /v0\.1\.0/);
  assert.doesNotMatch(text, /model not configured/i);
});

test("ConversationLogo still shows the configured model when available", () => {
  const frame = renderTuiToFrame(React.createElement(ConversationLogo, {
    version: "0.1.0",
    cwd: "E:\\Playground\\Swarm",
    model: "openai/gpt",
    columns: 100
  }), { columns: 100, rows: 12 });

  assert.match(frameText(frame), /v0\.1\.0 · openai\/gpt/);
});
