import { strict as assert } from "node:assert";
import test from "node:test";
import { chatInputCompletionRows, createChatInputControllerState } from "./chat-input-controller.js";
import type { SlashCommandSpec } from "./slash-commands.js";

test("chat input completion rows include hidden command count row", () => {
  const state = createChatInputControllerState();
  state.input = { value: "/x", cursor: 2 };
  const extraCommands: SlashCommandSpec[] = Array.from({ length: 6 }, (_, index) => ({
    name: `x-command-${index}`,
    group: "Core",
    usage: `/x-command-${index}`,
    description: "test command"
  }));

  assert.equal(chatInputCompletionRows(state, { extraCommands }), 8);
});
