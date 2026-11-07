import { strict as assert } from "node:assert";
import test from "node:test";
import {
  appendDetailShortcut,
  detailOpenHint,
  detailShortcutPhrase,
  shortcutHint,
  shortcutLabel,
  transcriptSearchHint,
  TUI_SHORTCUTS
} from "./shortcuts.js";

test("TUI shortcut registry formats detail and modal hints consistently", () => {
  assert.equal(shortcutHint(["command.select", "command.accept", "command.close"]), "Up/Down select | Tab accept | Esc close");
  assert.equal(shortcutHint(["approval.approve_once", "approval.allow_target", "approval.deny", "approval.cancel"]), "y yes | a always | n no | Esc no");
  assert.equal(detailShortcutPhrase(), "Ctrl+O for details");
  assert.equal(appendDetailShortcut("Work commands"), "Work commands. Ctrl+O for details.");
  assert.equal(appendDetailShortcut("Continue started", "preflight"), "Continue started. Ctrl+O for preflight.");
  assert.equal(detailOpenHint(), "Ctrl+O opens the latest detail.");
  assert.equal(transcriptSearchHint("2/4 matches"), "2/4 matches | Enter jump | Esc close");
});

test("worker rail toggle is registered with a discoverable Ctrl+R label", () => {
  const railToggle = TUI_SHORTCUTS["workers.toggle"];
  assert.deepEqual(railToggle.keys, ["Ctrl+R"]);
  assert.match(shortcutLabel("workers.toggle"), /Ctrl\+R/);
  assert.equal(shortcutHint(["workers.toggle"]), "Ctrl+R workers");
});

