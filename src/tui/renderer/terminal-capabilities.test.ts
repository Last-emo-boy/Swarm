import { strict as assert } from "node:assert";
import test from "node:test";
import {
  detectTuiTerminalCapabilities,
  sanitizeTerminalControlPayload,
  terminalClipboardSequence,
  terminalModeSequences,
  terminalNotificationSequence,
  terminalTabStatusSequence
} from "./terminal-capabilities.js";

test("terminal capabilities are optional and gated by terminal support", () => {
  assert.deepEqual(detectTuiTerminalCapabilities({ TERM: "dumb" }, { isTTY: false }), {
    rawMode: false,
    bracketedPaste: false,
    extendedKeyboard: false,
    mouse: false,
    focusReporting: false,
    hyperlinks: false,
    color: true,
    trueColor: false,
    colorLevel: 1,
    clipboard: false,
    notifications: false,
    tabStatus: false
  });

  const modern = detectTuiTerminalCapabilities({
    TERM_PROGRAM: "WezTerm",
    TERM: "xterm-256color",
    SWARM_TUI_CLIPBOARD: "1"
  }, { isTTY: true });
  assert.equal(modern.bracketedPaste, true);
  assert.equal(modern.mouse, true);
  assert.equal(modern.hyperlinks, true);
  assert.equal(modern.color, true);
  assert.equal(modern.trueColor, true);
  assert.equal(modern.colorLevel, 3);
  assert.equal(modern.clipboard, true);

  const noColor = detectTuiTerminalCapabilities({ TERM: "xterm-256color", NO_COLOR: "1" }, { isTTY: true });
  assert.equal(noColor.color, false);
  assert.equal(noColor.trueColor, false);
  assert.equal(noColor.colorLevel, 0);
  assert.equal(noColor.hyperlinks, false);
});

test("terminal capabilities follow cc-like color policy for vscode and tmux", () => {
  const vscode = detectTuiTerminalCapabilities({
    TERM_PROGRAM: "vscode",
    TERM: "xterm-256color"
  }, { isTTY: true });
  assert.equal(vscode.color, true);
  assert.equal(vscode.trueColor, true);
  assert.equal(vscode.colorLevel, 3);

  const windowsTerminal = detectTuiTerminalCapabilities({
    TERM: "xterm-256color",
    WT_SESSION: "session-id"
  }, { isTTY: true });
  assert.equal(windowsTerminal.trueColor, true);
  assert.equal(windowsTerminal.colorLevel, 3);

  const tmux = detectTuiTerminalCapabilities({
    TERM_PROGRAM: "iTerm.app",
    TERM: "tmux-256color",
    COLORTERM: "truecolor",
    TMUX: "/tmp/tmux-501/default,123,0"
  }, { isTTY: true });
  assert.equal(tmux.color, true);
  assert.equal(tmux.trueColor, false);
  assert.equal(tmux.colorLevel, 2);

  const tmuxTrueColor = detectTuiTerminalCapabilities({
    TERM_PROGRAM: "iTerm.app",
    TERM: "tmux-256color",
    TMUX: "/tmp/tmux-501/default,123,0",
    SWARM_TUI_TMUX_TRUECOLOR: "1"
  }, { isTTY: true });
  assert.equal(tmuxTrueColor.trueColor, true);
  assert.equal(tmuxTrueColor.colorLevel, 3);
});

test("terminal capability sequences are redacted and disabled when unsupported", () => {
  assert.equal(terminalModeSequences({ bracketedPaste: true, focusReporting: true, mouse: true }, true), "\u001B[?2004h\u001B[?1004h\u001B[?1000h\u001B[?1006h");
  assert.equal(terminalModeSequences({ bracketedPaste: true }, false), "\u001B[?2004l");
  assert.equal(terminalNotificationSequence("key sk-secret123", {}), "");
  assert.equal(terminalNotificationSequence("key sk-secret123", { notifications: true }), "\u001B]777;notify;Swarm;key sk-REDACTED\u0007");
  assert.equal(terminalClipboardSequence("copy sk-secret123", {}), "");
  assert.equal(terminalClipboardSequence("copy sk-secret123", { clipboard: true }), "\u001B]52;c;Y29weSBzay1SRURBQ1RFRA==\u0007");
  assert.equal(terminalTabStatusSequence("ready\u0007", { tabStatus: true }), "\u001B]0;ready\u0007");
  assert.equal(sanitizeTerminalControlPayload("hello\u001B sk-abc_DEF"), "hello  sk-REDACTED");
});
