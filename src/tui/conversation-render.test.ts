import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import React from "react";
import test from "node:test";
import { render } from "./ui.js";
import { ChatCommandCandidates, ChatInputArea } from "./ChatInputArea.js";
import { ConversationFirstPane } from "./components/ConversationFirstPane.js";
import { ConversationBottomChrome, ConversationFullscreenLayout } from "./components/ConversationFullscreenLayout.js";
import { createTuiRoot } from "./renderer/root.js";
import { renderTuiToFrame } from "./renderer/testing.js";
import { chatInputCompletionCandidates, createChatInputControllerState, selectedChatInputCompletionIndex } from "./chat-input-controller.js";
import { displayWidth } from "./display-width.js";
import { formatCompactIdleRows } from "./SwarmChatApp.js";
import type { ConversationMessage } from "./conversation-layout.js";
import { resolveTuiColor } from "./theme.js";
import type { ResultCard } from "../runtime/result-card.js";

test("default conversation surface renders without dashboard chrome", async () => {
  const output = await renderConversationFrame();
  const plain = terminalFrameText(output);

  assert.match(plain, /Swarm chat ready/);
  assert.match(plain, /❯ You\s+Keep the default TUI simple/);
  assert.match(plain, /Done/);
  assert.match(plain, /- Markdown stays multi-line/);
  assert.match(plain, /^\s*❯/m);
  assert.match(plain, /Ask Swarm/);
  assert.match(plain, /╭|─/);
  assert.match(plain, /^─{20,}$/m);
  assert.doesNotMatch(plain, /StatusRail|CurrentAction|View\s+\|/);
  assert.doesNotMatch(plain, /Overview|Trace\s+\| Ctrl\+N\/P/);
  assert.doesNotMatch(plain, /You Keep the default TUI simple|Note Swarm chat ready/);
});

test("default conversation surface shows a cc-style startup logo on empty chats", async () => {
  const output = await renderConversationFrame({
    messages: [{
      role: "system",
      kind: "logo",
      brief: "logo",
      title: "0.1.0",
      detail: "openai/gpt",
      preview: "E:\\Playground\\Swarm"
    }]
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /Swarm/);
  assert.match(plain, /Local workspace|openai\/gpt/);
  assert.doesNotMatch(plain, /Local coding agent/);
  assert.match(plain, /E:\\Playground\\Swarm/);
  assert.match(plain, /Start with/);
  assert.match(plain, /Review auth and permissions/);
  assert.doesNotMatch(plain, /\/review auth and permissions/);
  assert.doesNotMatch(plain, /Symphony|Local Swarm Runtime|coding team|blackboard|worker lease|protocol envelope/i);
  assert.match(plain, /Ask Swarm/);
});

test("default conversation surface renders command and tool transcript rows", async () => {
  const output = await renderConversationFrame({
    columns: 70,
    messages: [
      { role: "user", kind: "command", brief: "/shell npm test" },
      { role: "system", kind: "tool_use", status: "running", brief: "Run shell command: npm test" },
      {
        role: "system",
        kind: "tool_result",
        status: "success",
        brief: "shell.exec: command exited 0",
        preview: "shell.exec: command exited 0\n$ npm test\nok"
      },
      { role: "assistant", kind: "thinking", status: "running", brief: "Swarm is thinking" }
    ]
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /❯ cmd\s+\/shell npm test/);
  assert.match(plain, /Run shell command: npm test/);
  assert.match(plain, /shell\.exec: command exited 0/);
  assert.doesNotMatch(plain, /\$ npm test/);
  assert.match(plain, /Swarm is thinking/);
});

test("default conversation surface exposes semantic color diversity", () => {
  const frame = renderTuiToFrame(React.createElement(ConversationFullscreenLayout, {
    columns: 82,
    rows: 18,
    bottomRows: 4,
    scrollable: React.createElement(ConversationFirstPane, {
      messages: [
        { role: "user", kind: "command", brief: "/shell npm test" },
        { role: "system", kind: "tool_use", status: "running", brief: "Run shell command: npm test" },
        { role: "system", kind: "tool_result", status: "success", brief: "shell.exec: command exited 0" },
        { role: "system", kind: "approval", status: "pending", brief: "Approve file.write" },
        { role: "assistant", brief: "# Done\nThe result is ready." }
      ],
      rows: 14,
      columns: 80
    }),
    bottom: React.createElement(ChatInputArea, {
      onSubmit: () => undefined,
      onCompletionRowsChange: () => undefined,
      inputActive: false,
      maxRows: 4,
      footerItems: [
        { id: "tasks", label: "tasks", value: "1/2", tone: "running" },
        { id: "cache", label: "cache", value: "hit", tone: "success" },
        { id: "gateway", label: "gateway", value: "local", tone: "neutral" }
      ],
      selectedFooterItem: "cache"
    })
  }), { columns: 82, rows: 18 });

  const colors = new Set(frame.screen.cells.flatMap((row) => row.map((cell) => cell.style.color).filter(Boolean)));

  assert(colors.has(resolveTuiColor("role.user")));
  assert(colors.has(resolveTuiColor("role.tool")));
  assert(colors.has(resolveTuiColor("status.pending")));
  assert(colors.has(resolveTuiColor("brand.focus")));
  assert(colors.has(resolveTuiColor("text.primary")));
  assert(colors.size >= 5);
});

test("transcript rows color markers and labels without tinting neutral body text", () => {
  const frame = renderTuiToFrame(React.createElement(ConversationFirstPane, {
    messages: [
      { role: "user", kind: "command", brief: "/shell npm test" },
      { role: "system", kind: "tool_use", status: "running", brief: "Run shell command: npm test" },
      { role: "system", kind: "tool_result", status: "success", brief: "shell.exec: command exited 0" },
      { role: "assistant", brief: "The result is ready." }
    ],
    rows: 8,
    columns: 72
  }), { columns: 72, rows: 8 });

  const commandRow = frameRowWithText(frame, "❯ cmd");
  assert.equal(cellStyleAtText(commandRow, "❯")?.color, resolveTuiColor("role.user"));
  assert.equal(cellStyleAtText(commandRow, "/shell")?.color, resolveTuiColor("text.primary"));

  const toolRow = frameRowWithText(frame, "Run shell command");
  assert.equal(cellStyleAtText(toolRow, "●")?.color, resolveTuiColor("status.running"));
  assert.equal(cellStyleAtText(toolRow, "Run shell")?.color, resolveTuiColor("text.primary"));

  const resultRow = frameRowWithText(frame, "shell.exec");
  assert.equal(cellStyleAtText(resultRow, "✓")?.color, resolveTuiColor("status.success"));
  assert.equal(cellStyleAtText(resultRow, "shell.exec")?.color, resolveTuiColor("text.primary"));
});

test("transcript user rows use subtle background band while assistant body stays unbanded", () => {
  const frame = renderTuiToFrame(React.createElement(ConversationFirstPane, {
    messages: [
      { role: "user", brief: "TUI 现在只有一个颜色了" },
      { role: "assistant", brief: "I will keep body text neutral." }
    ],
    rows: 6,
    columns: 72
  }), { columns: 72, rows: 6 });

  const userRow = frameRowWithText(frame, "❯ You");
  const assistantRow = frameRowWithText(frame, "I will keep body text neutral.");

  assert.equal(cellStyleAtText(userRow, "❯")?.color, resolveTuiColor("role.user"));
  assert.equal(cellStyleAtText(userRow, "TUI")?.color, resolveTuiColor("text.primary"));
  assert.equal(cellStyleAtText(userRow, "❯")?.backgroundColor, resolveTuiColor("surface.user"));
  assert.equal(cellStyleAtText(userRow, "TUI")?.backgroundColor, resolveTuiColor("surface.user"));
  assert.equal(cellStyleAtText(assistantRow, "I will")?.color, resolveTuiColor("role.assistant"));
  assert.equal(cellStyleAtText(assistantRow, "I will")?.backgroundColor, undefined);
});

test("selected transcript rows use selection background without inverse swallowing semantic foregrounds", () => {
  const frame = renderTuiToFrame(React.createElement(ConversationFirstPane, {
    messages: [
      { role: "user", brief: "select this message" },
      { role: "assistant", brief: "not selected" }
    ],
    selectedMessageIndex: 0,
    rows: 6,
    columns: 72
  }), { columns: 72, rows: 6 });

  const userRow = frameRowWithText(frame, "❯ You");

  assert.equal(cellStyleAtText(userRow, "❯")?.color, resolveTuiColor("role.user"));
  assert.equal(cellStyleAtText(userRow, "select")?.color, resolveTuiColor("text.primary"));
  assert.equal(cellStyleAtText(userRow, "❯")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(userRow, "select")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(userRow, "❯")?.inverse, undefined);
});

test("search match highlight uses local background without swallowing row semantics", () => {
  const frame = renderTuiToFrame(React.createElement(ConversationFirstPane, {
    messages: [
      { role: "user", brief: "Find cache miss in this message" },
      { role: "assistant", brief: "cache miss is visible without tinting the whole row" }
    ],
    searchMatchMessageIndex: 0,
    searchMatchQuery: "cache miss",
    rows: 6,
    columns: 90
  }), { columns: 90, rows: 6 });

  const userRow = frameRowWithText(frame, "❯ You");

  assert.equal(cellStyleAtText(userRow, "❯")?.color, resolveTuiColor("role.user"));
  assert.equal(cellStyleAtText(userRow, "❯")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(userRow, "Find")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(userRow, "cache")?.backgroundColor, resolveTuiColor("surface.searchMatch"));
  assert.equal(cellStyleAtText(userRow, "cache")?.underline, true);
  assert.equal(cellStyleAtText(userRow, "cache")?.color, resolveTuiColor("text.primary"));
});

test("default conversation surface keeps multiline prompt visible at the bottom", async () => {
  const output = await renderConversationFrame({
    inputValue: "line one\nline two\nline three",
    bottomRows: 6
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /line one/);
  assert.match(plain, /line two/);
  assert.match(plain, /line three/);
  assert.doesNotMatch(plain, /Ask Swarm/);
});

test("chat input reports desired multiline height before the bottom slot expands", async () => {
  const rows = await renderChatInputRows({
    inputValue: "line one\nline two\nline three",
    maxRows: 3,
    maxInputRows: 4,
    completionPlacement: "overlay"
  });

  assert.equal(rows.at(-1), 2);
});

test("default conversation surface shows scroll chrome in the message area", async () => {
  const output = await renderConversationFrame({
    bottomRows: 4,
    scrollOffset: 7,
    rows: 10,
    messages: scrolledConversationMessages()
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /Jump to bottom/);
  assert.match(plain, /Jump to bottom ↓/);
  assert.match(plain, /^\s*❯/m);
  assert.equal(plainRows(plain).filter((line) => /^\s*❯\s+Keep the default TUI simple\./u.test(line)).length, 1);
});

test("default conversation surface shows new-message pill while scrolled away", async () => {
  const output = await renderConversationFrame({
    bottomRows: 4,
    scrollOffset: 4,
    rows: 10,
    newMessageCount: 2,
    unseenStartIndex: 2
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /2 new messages/);
  assert.match(plain, /2 new messages ↓/);
  assert.match(plain, /--- 2 new messages ---/);
});

test("default conversation surface fits a narrow viewport without horizontal overflow", async () => {
  const output = await renderConversationFrame({
    columns: 44,
    rows: 14,
    messages: [
      { role: "system", brief: "Swarm chat ready. Enter an objective." },
      { role: "user", brief: "请把默认 TUI 做得像 Claude Code 一样简单。" },
      {
        role: "assistant",
        brief: "This is a deliberately long assistant line that must wrap instead of overflowing the terminal width."
      }
    ]
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /Ask Swarm/);
  assert(plainRows(plain).every((line) => displayWidth(line) <= 44));
  assert.doesNotMatch(plain, /StatusRail|CurrentAction|Overview|Trace\s+\| Ctrl\+N\/P/);
});

test("default conversation surface keeps bottom input visible on short viewports", async () => {
  const output = await renderConversationFrame({
    columns: 58,
    rows: 8,
    bottomRows: 4,
    scrollOffset: 6,
    newMessageCount: 1,
    unseenStartIndex: 2
  });
  const plain = terminalFrameText(output);
  const rows = plainRows(plain);

  assert.match(plain, /1 new message ↓|Jump to bottom ↓/);
  assert(rows.slice(-4).some((line) => line.includes("❯") || line.includes("Ask Swarm")));
  assert(rows.every((line) => displayWidth(line) <= 58));
});

test("default conversation surface keeps prompt visible when slash completions open on short viewports", async () => {
  const closedOutput = await renderConversationFrame({
    columns: 58,
    rows: 8,
    bottomRows: 4
  });
  const output = await renderConversationFrame({
    columns: 58,
    rows: 8,
    bottomRows: 4,
    completionPlacement: "overlay",
    inputValue: "/"
  });
  const closedPromptRow = promptRowIndex(terminalFrameText(closedOutput));
  const plain = terminalFrameText(output);
  const rows = plainRows(plain);

  assert.doesNotMatch(plain, /Command Palette|COMMAND PALETTE/);
  assert.match(plain, /\/help/);
  assert.equal(promptRowIndex(plain), closedPromptRow);
  assert(rows.slice(-2).some((line) => line.includes("❯") || line.includes("/")));
  assert(rows.every((line) => displayWidth(line) <= 58));
});

test("chat input renders a stable focused mode hint without moving the prompt", async () => {
  const plain = terminalFrameText(await renderConversationFrame({
    columns: 64,
    rows: 10,
    bottomRows: 4,
    promptLabel: "work",
    sandboxLabel: "rw"
  }));
  const promptRow = plainRows(plain).find((line) => line.includes("❯") || line.includes("Ask Swarm")) ?? "";

  assert.match(promptRow, /\[WORK RW\]/);
  assert.match(promptRow, /❯\s+Ask Swarm/);
  assert.equal(displayWidth(promptRow) <= 64, true);

  const compact = terminalFrameText(await renderConversationFrame({
    columns: 44,
    rows: 10,
    bottomRows: 4,
    promptLabel: "coding-loop",
    sandboxLabel: "workspace-write",
    density: "compact"
  }));
  const compactPromptRow = plainRows(compact).find((line) => line.includes("❯") || line.includes("Ask Swarm")) ?? "";

  assert.match(compactPromptRow, /\[CODING-LOO RW\]/);
  assert.equal(displayWidth(compactPromptRow) <= 44, true);
});

test("chat input footer renders cc-style semantic status pills and muted hint", () => {
  const frame = renderTuiToFrame(React.createElement(ChatInputArea, {
    onSubmit: () => undefined,
    onCompletionRowsChange: () => undefined,
    inputActive: false,
    footerModeLabel: "WORK",
    footerPermissionLabel: "YOLO",
    footerPermissionTone: "status.danger",
    footerSandboxLabel: "RW",
    footerSandboxTone: "status.success",
    footerItems: [
      { id: "tasks", label: "tasks", value: "1/2", tone: "running" },
      { id: "cache", label: "cache", value: "hit", tone: "success" },
      { id: "lsp", label: "lsp", value: "ts", tone: "success" }
    ],
    selectedFooterItem: "cache",
    footerHint: "Left/Right footer | [/] message | / search",
    columns: 120,
    maxRows: 4
  }), { columns: 120, rows: 5 });
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("").trimEnd()).join("\n");
  const footerRow = frame.screen.cells.find((row) => row.some((cell) => cell.char === "[" && cell.style.color !== undefined));
  assert(footerRow);

  assert.match(plain, /\[WORK\]/);
  assert.match(plain, /\[YOLO\]/);
  assert.match(plain, /\[RW\]/);
  assert.match(plain, /\[cache:hit\]/);
  assert.match(plain, /Left\/Right footer \| \[\/\] message \| \/ search/);

  const line = footerRow!.map((cell) => cell.char).join("");
  const cacheIndex = line.indexOf("[cache:hit]");
  const yoloIndex = line.indexOf("[YOLO]");
  assert(cacheIndex >= 0);
  assert(yoloIndex >= 0);
  assert.equal(footerRow![cacheIndex]?.style.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(footerRow![cacheIndex]?.style.inverse, undefined);
  assert.equal(footerRow![yoloIndex]?.style.color, resolveTuiColor("status.danger"));
});

test("chat input footer dispatches mouse clicks on service pills", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 120,
    rows: 5,
    terminalCapabilities: { mouse: true }
  });
  root.render(React.createElement(ChatInputArea, {
    onSubmit: () => undefined,
    onCompletionRowsChange: () => undefined,
    inputActive: false,
    footerModeLabel: "WORK",
    footerSandboxLabel: "RW",
    footerItems: [
      { id: "tasks", label: "tasks", value: "1/2", tone: "running" },
      { id: "cache", label: "cache", value: "HIT", tone: "success" }
    ],
    selectedFooterItem: "cache",
    onFooterItemClick: (id) => clicked.push(id),
    footerHint: "Left/Right footer | [/] message | / search",
    columns: 120,
    maxRows: 4
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findCell(frame, "[cache:HIT]");
  assert(target, "expected cache footer pill to render");

  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, ["cache"]);
  root.unmount();
});

test("chat input footer mouse clicks are disabled with terminal mouse capability off", () => {
  const clicked: string[] = [];
  const root = createTuiRoot({
    columns: 120,
    rows: 5,
    terminalCapabilities: { mouse: false }
  });
  root.render(React.createElement(ChatInputArea, {
    onSubmit: () => undefined,
    onCompletionRowsChange: () => undefined,
    inputActive: false,
    footerItems: [
      { id: "cache", label: "cache", value: "HIT", tone: "success" }
    ],
    onFooterItemClick: (id) => clicked.push(id),
    columns: 120,
    maxRows: 4
  }));

  const frame = root.getFrame();
  assert(frame);
  const target = findCell(frame, "[cache:HIT]");
  assert(target, "expected cache footer pill to render");

  root.dispatchMouse({ x: target.x, y: target.y, button: "left", action: "press" });

  assert.deepEqual(clicked, []);
  root.unmount();
});

test("chat input footer uses a two-zone service surface on wide terminals", () => {
  const frame = renderTuiToFrame(React.createElement(ChatInputArea, {
    onSubmit: () => undefined,
    onCompletionRowsChange: () => undefined,
    inputActive: false,
    footerModeLabel: "WORK",
    footerPermissionLabel: "YOLO",
    footerPermissionTone: "status.danger",
    footerSandboxLabel: "RW",
    footerSandboxTone: "status.success",
    footerItems: [
      { id: "tasks", label: "tasks", value: "1/2", tone: "running" },
      { id: "cache", label: "cache", value: "HIT", tone: "success" },
      { id: "lsp", label: "lsp", value: "TS", tone: "success" },
      { id: "gateway", label: "gateway", value: "local", tone: "success" },
      { id: "symphony", label: "symphony", value: "2 run", tone: "running" }
    ],
    selectedFooterItem: "lsp",
    footerHint: "Left/Right footer | [/] message | / search",
    columns: 140,
    maxRows: 4
  }), { columns: 140, rows: 5 });
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("").trimEnd()).join("\n");
  const footerRow = frameRowWithText(frame, "[lsp:TS]");
  const line = rowText(footerRow);
  const hintIndex = line.indexOf("Left/Right footer");
  const lspIndex = line.indexOf("[lsp:TS]");

  assert.match(plain, /\[cache:HIT\]/);
  assert.match(plain, /\[gateway:local\]/);
  assert.match(plain, /\[symphony:2 run\]/);
  assert(hintIndex > lspIndex, "hint should render as the right footer zone");
  assert.equal(cellStyleAtText(footerRow, "[lsp:TS]")?.backgroundColor, resolveTuiColor("surface.selection"));
});

test("chat input footer hides shortcut hint while typing", () => {
  const frame = renderTuiToFrame(React.createElement(ChatInputArea, {
    onSubmit: () => undefined,
    onCompletionRowsChange: () => undefined,
    inputActive: false,
    footerModeLabel: "WORK",
    footerPermissionLabel: "YOLO",
    footerPermissionTone: "status.danger",
    footerItems: [
      { id: "cache", label: "cache", value: "HIT", tone: "success" }
    ],
    footerHint: "Left/Right footer | [/] message | / search",
    columns: 120,
    maxRows: 4,
    controllerStateRef: {
      current: {
        ...createChatInputControllerState(),
        input: { value: "hello", cursor: 5 }
      }
    }
  }), { columns: 120, rows: 5 });
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("").trimEnd()).join("\n");

  assert.match(plain, /\[WORK\]/);
  assert.match(plain, /\[cache:HIT\]/);
  assert.doesNotMatch(plain, /Left\/Right footer/);
});

test("chat input footer compresses search state into the left surface", () => {
  const frame = renderTuiToFrame(React.createElement(ChatInputArea, {
    onSubmit: () => undefined,
    onCompletionRowsChange: () => undefined,
    inputActive: false,
    footerModeLabel: "WORK",
    footerPermissionLabel: "YOLO",
    footerPermissionTone: "status.danger",
    footerSandboxLabel: "RW",
    footerSandboxTone: "status.success",
    footerActivityLabel: "search",
    footerActivityValue: "1/3 cache miss",
    footerActivityTone: "surface.searchMatch",
    footerItems: [
      { id: "cache", label: "cache", value: "HIT", tone: "success" },
      { id: "lsp", label: "lsp", value: "TS", tone: "success" },
      { id: "gateway", label: "gateway", value: "LOCAL", tone: "success" },
      { id: "symphony", label: "symphony", value: "2 run", tone: "running" }
    ],
    selectedFooterItem: "gateway",
    footerHint: "search 1/3 cache miss | Enter jump | Esc close",
    columns: 80,
    maxRows: 4
  }), { columns: 80, rows: 5 });
  const plain = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("").trimEnd()).join("\n");
  const searchRow = frameRowWithText(frame, "[search:1/3");

  assert.match(plain, /\[search:1\/3 cache miss\]/);
  assert.match(plain, /\[gateway:LOCAL\]|\[gw:LOCAL\]/);
  assert.doesNotMatch(plain, /Enter jump|Esc close/);
  assert.equal(cellStyleAtText(searchRow, "[search")?.color, resolveTuiColor("surface.searchMatch"));
  assert.equal(cellStyleAtText(searchRow, rowText(searchRow).includes("[gateway:") ? "gateway" : "gw")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert(frame.screen.cells.map((row) => rowText(row).trimEnd()).every((line) => displayWidth(line) <= 80));
});

test("chat input footer drops low-priority pills before overflowing narrow terminals", () => {
  const frame = renderTuiToFrame(React.createElement(ChatInputArea, {
    onSubmit: () => undefined,
    onCompletionRowsChange: () => undefined,
    inputActive: false,
    footerModeLabel: "coding-loop",
    footerPermissionLabel: "FULL-AUTO",
    footerPermissionTone: "status.warning",
    footerSandboxLabel: "workspace-write",
    footerSandboxTone: "status.success",
    footerItems: [
      { id: "tasks", label: "tasks", value: "123/456", tone: "running" },
      { id: "cache", label: "cache", value: "cache_miss 0%", tone: "pending" },
      { id: "gateway", label: "gateway", value: "local-provider", tone: "neutral" },
      { id: "symphony", label: "symphony", value: "10 run", tone: "running" },
      { id: "lsp", label: "lsp", value: "unknown", tone: "muted" }
    ],
    footerHint: "Left/Right footer | [/] message | / search",
    columns: 44,
    maxRows: 4,
    density: "compact"
  }), { columns: 44, rows: 5 });
  const lines = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("").trimEnd()).filter(Boolean);

  assert(lines.every((line) => displayWidth(line) <= 44));
  assert(lines.some((line) => line.includes("[CODING-LOO]")));
  assert(lines.some((line) => line.includes("[FULL-AUTO]")));
  assert.doesNotMatch(lines.join("\n"), /Left\/Right footer/);
});

test("chat input footer reserves space for selected service on compact terminals", () => {
  const frame = renderTuiToFrame(React.createElement(ChatInputArea, {
    onSubmit: () => undefined,
    onCompletionRowsChange: () => undefined,
    inputActive: false,
    footerModeLabel: "coding-loop",
    footerPermissionLabel: "FULL-AUTO",
    footerPermissionTone: "status.warning",
    footerSandboxLabel: "workspace-write",
    footerSandboxTone: "status.success",
    footerItems: [
      { id: "tasks", label: "tasks", value: "123/456", tone: "running" },
      { id: "approvals", label: "approvals", value: "3", tone: "pending" },
      { id: "cache", label: "cache", value: "MISS 0%", tone: "pending" },
      { id: "gateway", label: "gateway", value: "LOCAL", tone: "success" },
      { id: "symphony", label: "symphony", value: "2 run/1 retry", tone: "running" },
      { id: "lsp", label: "lsp", value: "NO PROVIDER", tone: "muted" }
    ],
    selectedFooterItem: "symphony",
    footerHint: "Left/Right footer | [/] message | / search",
    columns: 44,
    maxRows: 4,
    density: "compact"
  }), { columns: 44, rows: 5 });
  const lines = frame.screen.cells.map((row) => rowText(row).trimEnd()).filter(Boolean);
  const footerText = lines.join("\n");
  const selectedRow = frameRowWithText(frame, "[sym:");

  assert.match(footerText, /\[sym:2 run\/1 r\]/);
  assert.doesNotMatch(footerText, /Left\/Right footer/);
  assert.equal(cellStyleAtText(selectedRow, "[sym:")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert(lines.every((line) => displayWidth(line) <= 44));
});

test("slash command candidates use cc-style selected background and aligned columns", () => {
  const frame = renderTuiToFrame(React.createElement(ChatCommandCandidates, {
    candidates: [
      { name: "help", group: "Core", usage: "/help", description: "Show grouped slash command help." },
      { name: "shell", group: "Tools", usage: "/shell <command>", description: "Run a shell command with policy approval when required." },
      { name: "capabilities", group: "Config", usage: "/capabilities [kind|provider|query|all]", description: "Summarize registered local capabilities." }
    ],
    selectedIndex: 1,
    maxRows: 8,
    columns: 96
  }), { columns: 96, rows: 8 });
  const selectedRow = frameRowWithText(frame, "/shell <command>");
  const unselectedRow = frameRowWithText(frame, "/help");
  const selectedText = rowText(selectedRow);
  const unselectedText = rowText(unselectedRow);

  assert(selectedText.includes("› /shell <command>"));
  assert(selectedText.includes("[Tools]"));
  assert(unselectedText.includes("  /help"));
  assert.equal(selectedText.indexOf("[Tools]"), unselectedText.indexOf("[Core]"));
  assert.equal(cellStyleAtText(selectedRow, "›")?.color, resolveTuiColor("brand.focus"));
  assert.equal(cellStyleAtText(selectedRow, "›")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(selectedRow, "/shell")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(selectedRow, "[Tools]")?.color, resolveTuiColor("role.tool"));
  assert.equal(cellStyleAtText(selectedRow, "Run a shell")?.color, resolveTuiColor("text.primary"));
  assert.equal(cellStyleAtText(unselectedRow, "/help")?.backgroundColor, undefined);
  assert(frame.screen.cells.map((row) => rowText(row).trimEnd()).every((line) => displayWidth(line) <= 96));
});

test("slash command overlay keeps selected row background and omits title chrome", () => {
  const frame = renderTuiToFrame(React.createElement(ChatCommandCandidates, {
    candidates: [
      { name: "model", group: "Config", usage: "/model [planner|worker|aggregator] [provider/model]", description: "Show or update selected models." },
      { name: "capabilities", group: "Config", usage: "/capabilities [kind|provider|query|all]", description: "Summarize registered local capabilities." },
      { name: "mcp-refresh", group: "Config", usage: "/mcp-refresh <server_id>", description: "Reconnect one configured MCP stdio server and refresh tools." }
    ],
    selectedIndex: 1,
    maxRows: 5,
    columns: 72,
    overlay: true
  }), { columns: 72, rows: 5 });
  const plain = frame.screen.cells.map((row) => rowText(row).trimEnd()).join("\n");
  const selectedRow = frameRowWithText(frame, "/capabilities");

  assert.doesNotMatch(plain, /Command Palette/);
  assert.match(rowText(selectedRow), /^\s*› \/capabilities/);
  assert.equal(cellStyleAtText(selectedRow, "›")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(selectedRow, "[Config]")?.color, resolveTuiColor("role.tool"));
  assert.equal(rowText(selectedRow).length >= 72, true);
});

test("slash command overlay keeps 80-column selected row stable under long descriptions", () => {
  const frame = renderTuiToFrame(React.createElement(ChatCommandCandidates, {
    candidates: [
      { name: "doctor", group: "Core", usage: "/doctor", description: "Diagnose configuration, cache, LSP, gateway, providers, and terminal rendering in one pass." },
      { name: "symphony", group: "Symphony", usage: "/symphony inspect --workers --gateway --cache", description: "Inspect scheduler, workers, gateway routing, cache evidence, and provider state without leaving the prompt overlay." },
      { name: "model", group: "Config", usage: "/model [planner|worker|aggregator] [provider/model]", description: "Show or update selected models." }
    ],
    selectedIndex: 1,
    maxRows: 5,
    columns: 80,
    overlay: true
  }), { columns: 80, rows: 5 });
  const plain = frame.screen.cells.map((row) => rowText(row).trimEnd()).join("\n");
  const selectedRow = frameRowWithText(frame, "/symphony");

  assert.doesNotMatch(plain, /Command Palette|tab accept|esc close/);
  assert.equal(cellStyleAtText(selectedRow, "›")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(selectedRow, "/symphony")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(selectedRow, "[Symphony]")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(selectedRow, "Inspect")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(selectedRow, "[Symphony]")?.color, resolveTuiColor("role.tool"));
  assert.equal(rowText(selectedRow).length >= 80, true);
  assert(frame.screen.cells.map((row) => rowText(row).trimEnd()).every((line) => displayWidth(line) <= 80));
});

test("slash completion overlay centers the selected command without title chrome", async () => {
  const output = await renderConversationFrame({
    columns: 72,
    rows: 12,
    bottomRows: 4,
    completionPlacement: "overlay",
    inputValue: "/cap"
  });
  const plain = terminalFrameText(output);
  const rows = plainRows(plain);

  assert.doesNotMatch(plain, /Command Palette|COMMAND PALETTE|Up\/Down select/);
  assert.match(plain, /\/capabilities/);
  assert(rows.some((line) => line.trimStart().startsWith("› /capabilities")));
  assert(rows.some((line) => line.includes("[Config]")));
  assert(rows.slice(-2).some((line) => line.includes("❯") || line.includes("/cap")));
  assert(rows.every((line) => displayWidth(line) <= 72));
});

test("default conversation surface hides slash completions before they can displace the prompt", async () => {
  const output = await renderConversationFrame({
    columns: 58,
    rows: 7,
    bottomRows: 4,
    completionPlacement: "inline",
    inputValue: "/"
  });
  const plain = terminalFrameText(output);
  const rows = plainRows(plain);

  assert.doesNotMatch(plain, /Command Palette/);
  assert(rows.slice(-2).some((line) => line.includes("❯") || line.includes("/")));
  assert(rows.every((line) => displayWidth(line) <= 58));
});

test("default conversation surface renders long markdown as multiple terminal rows", async () => {
  const output = await renderConversationFrame({
    columns: 64,
    rows: 18,
    messages: [
      { role: "system", brief: "Swarm chat ready. Enter an objective." },
      { role: "user", brief: "Show a long markdown report." },
      {
        role: "assistant",
        brief: "Report",
        detail: [
          "Result",
          "",
          "Full Output",
          "# Report",
          "This paragraph is intentionally long so the TUI must render it across several rows instead of compressing it into one unreadable line.",
          "",
          "| Area | Status |",
          "| --- | --- |",
          "| TUI | Done |",
          "",
          "```ts",
          "const viewport = 'conversation-first';",
          "```"
        ].join("\n")
      }
    ]
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /Report/);
  assert.match(plain, /Area\s+Status/);
  assert.match(plain, /const viewport = 'conversation-first';/);
  assert(plainRows(plain).filter((line) => line.includes("This paragraph")).length <= 1);
  assert(plainRows(plain).every((line) => displayWidth(line) <= 64));
});

test("default conversation surface keeps activity and result in fixed bottom chrome", async () => {
  const running = terminalFrameText(await renderConversationFrame({
    rows: 12,
    bottomRows: 5,
    bottomChrome: {
      busy: true,
      activity: "#4 running verification",
      motionFrame: 1
    }
  }));
  assert.match(running, /\/ running verification/);
  assert(running.indexOf("running verification") > running.indexOf("Done"));

  const completed = terminalFrameText(await renderConversationFrame({
    rows: 13,
    bottomRows: 6,
    bottomChrome: {
      resultCard: sampleResultCard(),
      detailAvailable: true
    }
  }));
  assert.match(completed, /\[OK\] Updated the TUI layout/);
  assert.match(completed, /2 changed · 1 checks · Ctrl\+O for details/);
  assert(completed.indexOf("Updated the TUI layout") > completed.indexOf("Done"));
});

test("compact idle rows keep attention-first scan order in narrow text", () => {
  const rows = formatCompactIdleRows([
    {
      key: "output-ok",
      id: "task-output-success-with-long-id",
      title: "Finished collecting command output",
      status: "success",
      meta: ["saved", "full=E:/very/long/path/to/output.log"],
      priority: 10
    },
    {
      key: "approval",
      id: "approval-risky-file-write-123456789",
      title: "file.write E:/very/long/workspace/src/tui/SwarmChatApp.tsx",
      status: "pending",
      meta: ["r3/write", "session=session-visual-polish-123456789"],
      priority: 83
    },
    {
      key: "worker",
      id: "worker-running-123456789",
      title: "Apply compact idle row polish",
      status: "running",
      meta: ["coder", "scope=src/tui/SwarmChatApp.tsx"],
      priority: 75
    }
  ]);

  assert.match(rows[0] ?? "", /\[ASK\] approval-/);
  assert.match(rows[1] ?? "", /\[RUN\] worker-/);
  assert.match(rows[2] ?? "", /\[OK\] task-output/);
  assert(rows.every((line) => displayWidth(line) <= 132));
  assert(rows.every((line) => !line.includes("123456789")));
});

test("default conversation status hides turn-budget metadata", async () => {
  const output = await renderConversationFrame({
    rows: 12,
    bottomRows: 5,
    bottomChrome: {
      busy: true,
      activity: "Swarm is thinking",
      motionFrame: 2
    }
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /- Swarm is thinking/);
  assert.doesNotMatch(plain, /#12|turn\s+12|thinking:/i);
});

async function renderConversationFrame(options: {
  columns?: number;
  bottomRows?: number;
  scrollOffset?: number;
  rows?: number;
  inputValue?: string;
  completionPlacement?: "inline" | "overlay";
  promptLabel?: string;
  sandboxLabel?: string;
  density?: "compact" | "default" | "comfortable";
  newMessageCount?: number;
  unseenStartIndex?: number;
  messages?: ConversationMessage[];
  bottomChrome?: {
    busy?: boolean;
    activity?: string;
    motionFrame?: number;
    resultCard?: ResultCard;
    detailAvailable?: boolean;
  };
} = {}): Promise<string> {
  const {
    columns = 80,
    bottomRows = 4,
    scrollOffset = 0,
    rows = 20,
    inputValue = "",
    completionPlacement = "inline",
    promptLabel,
    sandboxLabel,
    density,
    newMessageCount = 0,
    unseenStartIndex,
    messages = defaultConversationMessages(),
    bottomChrome
  } = options;
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  const controllerState = { current: { ...createChatInputControllerState(), input: { value: inputValue, cursor: inputValue.length } } };
  const candidates = chatInputCompletionCandidates(controllerState.current);
  const completionOverlay = completionPlacement === "overlay" && candidates.length > 0
    ? React.createElement(ChatCommandCandidates, {
      candidates,
      selectedIndex: selectedChatInputCompletionIndex(controllerState.current),
      maxRows: Math.max(1, rows - bottomRows - 1),
      columns,
      overlay: true
    })
    : undefined;

  const app = render(
    React.createElement(ConversationFullscreenLayout, {
      columns,
      rows,
      bottomRows,
      completionOverlay,
      completionOverlayRows: Math.max(1, rows - bottomRows - 1),
      scrollable: React.createElement(ConversationFirstPane, {
        messages,
        rows: rows - bottomRows,
        columns: Math.max(20, columns - 2),
        scrollOffset,
        newMessageCount,
        unseenStartIndex
      }),
      bottom: bottomChrome
        ? React.createElement(ConversationBottomChrome, {
          ...bottomChrome,
          input: React.createElement(ChatInputArea, {
            onSubmit: () => undefined,
            onCompletionRowsChange: () => undefined,
            controllerStateRef: controllerState,
            inputActive: false,
            completionPlacement,
            promptLabel,
            sandboxLabel,
            density,
            maxRows: Math.max(1, bottomRows - (bottomChrome.busy ? 1 : bottomChrome.resultCard ? 2 : 0))
          })
        })
        : React.createElement(ChatInputArea, {
          onSubmit: () => undefined,
          onCompletionRowsChange: () => undefined,
          controllerStateRef: controllerState,
          inputActive: false,
          completionPlacement,
          promptLabel,
          sandboxLabel,
          density,
          maxRows: bottomRows
        })
    }),
    { stdout: stream as unknown as NodeJS.WriteStream, stderr: stream as unknown as NodeJS.WriteStream, patchConsole: false }
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  app.unmount();
  return output;
}

async function renderChatInputRows(options: {
  inputValue: string;
  maxRows: number;
  maxInputRows: number;
  completionPlacement: "inline" | "overlay";
}): Promise<number[]> {
  const stream = new PassThrough();
  const rows: number[] = [];
  const controllerState = {
    current: {
      ...createChatInputControllerState(),
      input: { value: options.inputValue, cursor: options.inputValue.length }
    }
  };
  const app = render(
    React.createElement(ChatInputArea, {
      onSubmit: () => undefined,
      onCompletionRowsChange: (rowCount: number) => rows.push(rowCount),
      controllerStateRef: controllerState,
      inputActive: false,
      completionPlacement: options.completionPlacement,
      maxRows: options.maxRows,
      maxInputRows: options.maxInputRows
    }),
    { stdout: stream as unknown as NodeJS.WriteStream, stderr: stream as unknown as NodeJS.WriteStream, patchConsole: false }
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  app.unmount();
  return rows;
}

function defaultConversationMessages(): ConversationMessage[] {
  return [
    { role: "system", brief: "Swarm chat ready. Enter an objective." },
    { role: "user", brief: "Keep the default TUI simple." },
    {
      role: "assistant",
      brief: "Finished.",
      detail: [
        "Result",
        "",
        "Full Output",
        "# Done",
        "First line",
        "Second line",
        "",
        "- Markdown stays multi-line",
        "- 中文宽字符也会换行"
      ].join("\n")
    }
  ];
}

function scrolledConversationMessages(): ConversationMessage[] {
  return [
    { role: "system", brief: "Swarm chat ready. Enter an objective." },
    { role: "user", brief: "Keep the default TUI simple." },
    {
      role: "assistant",
      brief: Array.from({ length: 14 }, (_, index) => `assistant line ${index + 1}`).join("\n")
    }
  ];
}

function sampleResultCard(): ResultCard {
  return {
    sessionId: "session-1",
    status: "completed",
    route: "work",
    summary: "Updated the TUI layout",
    changedFiles: ["src/tui/SwarmChatApp.tsx", "src/tui/components/ConversationFullscreenLayout.tsx"],
    checks: [{ command: "npm test", status: "passed" }],
    review: { status: "skipped", summary: "not recorded" },
    risks: [],
    artifacts: [],
    next: []
  };
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "");
}

function terminalFrameText(value: string): string {
  const rows: string[][] = [];
  let cursorRow = 0;
  let cursorColumn = 0;

  function ensureRow(row: number): string[] {
    while (rows.length <= row) {
      rows.push([]);
    }
    return rows[row]!;
  }

  function write(text: string): void {
    for (const char of stripAnsi(text)) {
      if (char === "\n") {
        cursorRow += 1;
        cursorColumn = 0;
        continue;
      }
      if (char === "\r") {
        cursorColumn = 0;
        continue;
      }
      const row = ensureRow(cursorRow);
      row[cursorColumn] = char;
      cursorColumn += Math.max(1, displayWidth(char));
    }
  }

  const tokenPattern = /\x1B\[(\d+)(?:;(\d+))?([HJK])|\x1B\][^\x07]*(?:\x07|\x1B\\)/g;
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(value))) {
    write(value.slice(offset, match.index));
    offset = tokenPattern.lastIndex;
    const command = match[3];
    if (command === "J" && match[1] === "2") {
      rows.splice(0);
      cursorRow = 0;
      cursorColumn = 0;
    } else if (command === "H") {
      cursorRow = Math.max(0, Number.parseInt(match[1] ?? "1", 10) - 1);
      cursorColumn = Math.max(0, Number.parseInt(match[2] ?? "1", 10) - 1);
    } else if (command === "K" && match[1] === "2") {
      rows[cursorRow] = [];
      cursorColumn = 0;
    }
  }
  write(value.slice(offset));

  return rows.map((row) => row.join("").trimEnd()).join("\n");
}

function plainRows(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}

type FrameRow = ReturnType<typeof renderTuiToFrame>["screen"]["cells"][number];

function frameRowWithText(frame: ReturnType<typeof renderTuiToFrame>, text: string): FrameRow {
  const row = frame.screen.cells.find((candidate) => rowText(candidate).includes(text));
  assert(row, `Expected frame row containing ${text}`);
  return row;
}

function cellStyleAtText(row: FrameRow, text: string): FrameRow[number]["style"] | undefined {
  const index = rowText(row).indexOf(text);
  assert(index >= 0, `Expected row to contain ${text}`);
  return row[index]?.style;
}

function findCell(frame: NonNullable<ReturnType<ReturnType<typeof createTuiRoot>["getFrame"]>>, needle: string): { x: number; y: number } | undefined {
  for (let y = 0; y < frame.screen.height; y += 1) {
    const line = frame.screen.cells[y]?.map((cell) => cell.char).join("") ?? "";
    const x = line.indexOf(needle);
    if (x >= 0) {
      return { x, y };
    }
  }
  return undefined;
}

function rowText(row: FrameRow): string {
  return row.map((cell) => cell.char).join("");
}

function promptRowIndex(value: string): number {
  const rows = terminalRows(value);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const line = rows[index] ?? "";
    if (line.includes("❯") || line.includes("Ask Swarm")) {
      return index;
    }
  }
  return -1;
}

function terminalRows(value: string): string[] {
  const rows = value.split(/\r?\n/);
  while (rows.at(-1) === "") {
    rows.pop();
  }
  return rows;
}
