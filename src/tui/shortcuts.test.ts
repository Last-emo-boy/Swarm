import { strict as assert } from "node:assert";
import test from "node:test";
import {
  appendDetailShortcut,
  detailOpenHint,
  detailShortcutPhrase,
  shortcutHint,
  transcriptSearchHint
} from "./shortcuts.js";

test("TUI shortcut registry formats detail and modal hints consistently", () => {
  assert.equal(shortcutHint(["command.select", "command.accept", "command.close"]), "Up/Down select | Tab accept | Esc close");
  assert.equal(shortcutHint(["approval.approve_once", "approval.allow_target", "approval.deny", "approval.cancel"]), "Y approve once | S allow target | N deny | Esc cancel");
  assert.equal(shortcutHint(["collab.ownership", "collab.negotiation", "collab.blackboard", "collab.reassign"]), "O ownership | N negotiations | B blackboard | R reassign");
  assert.equal(detailShortcutPhrase(), "Ctrl+O for details");
  assert.equal(appendDetailShortcut("Work commands"), "Work commands. Ctrl+O for details.");
  assert.equal(appendDetailShortcut("Continue started", "preflight"), "Continue started. Ctrl+O for preflight.");
  assert.equal(detailOpenHint(), "Ctrl+O opens the latest detail.");
  assert.equal(transcriptSearchHint("2/4 matches"), "2/4 matches | Enter jump | Esc close");
});
