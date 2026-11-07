import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import React from "react";
import test from "node:test";
import { render } from "./ui.js";
import { ChatCommandCandidates, ChatInputArea } from "./ChatInputArea.js";
import { ConversationFirstPane } from "./components/ConversationFirstPane.js";
import { ConversationFullscreenLayout, ConversationStatusLine } from "./components/ConversationFullscreenLayout.js";
import { StatusLine } from "./components/StatusLine.js";
import { createTuiRoot } from "./renderer/root.js";
import { renderTuiToFrame } from "./renderer/testing.js";
import { chatInputCompletionCandidates, createChatInputControllerState, selectedChatInputCompletionIndex } from "./chat-input-controller.js";
import { displayWidth } from "./display-width.js";
import { formatCompactIdleRows } from "./SwarmChatApp.js";
import type { ConversationMessage } from "./conversation-layout.js";
import { buildStatusLine, type StatusItemId } from "./status-line.js";
import { resolveTuiColor } from "./theme.js";

test("default conversation surface renders without dashboard chrome", async () => {
  const output = await renderConversationFrame();
  const plain = terminalFrameText(output);

  assert.match(plain, /^ *· Swarm chat ready/m);
  assert.match(plain, /^ *› Keep the default TUI simple/m);
  assert.match(plain, /Done/);
  assert.match(plain, /- Markdown stays multi-line/);
  assert.match(plain, /^ *› Ask Swarm$/m);
  assert.match(plain, /^─{20,}$/m);
  assert.doesNotMatch(plain, /╭|❯|\buser\b|\bsystem\b|\[WORK|\[RW/);
  assert.doesNotMatch(plain, /StatusRail|CurrentAction|View\s+\|/);
  assert.doesNotMatch(plain, /Overview|Trace\s+\| Ctrl\+N\/P/);
});

test("an empty chat shows two quiet lines instead of a logo", async () => {
  const plain = terminalFrameText(await renderConversationFrame({ messages: [], workspace: "~/Playground/swarm" }));
  const rows = plainRows(plain);

  assert.equal(rows[0], " Ask anything about ~/Playground/swarm.");
  assert.equal(rows[1], " / commands · ? keys");
  assert.doesNotMatch(plain, /Symphony Swarm|Local Agent OS/);
  assert.match(plain, /Ask Swarm/);
});

test("tool calls are one row each while the turn runs and fold into one line once it ends", async () => {
  const running = terminalFrameText(await renderConversationFrame({
    columns: 70,
    messages: [
      { role: "user", kind: "command", brief: "/shell npm test" },
      { role: "system", kind: "tool_use", status: "success", id: "tool:1", tool: { verb: "Read", target: "package.json" }, brief: "Read package.json" },
      { role: "system", kind: "tool_use", status: "running", id: "tool:2", tool: { verb: "Bash", target: "npm test", approval: "approved" }, brief: "Bash npm test" }
    ]
  }));
  assert.match(running, /^ *› \/shell npm test$/m);
  assert.match(running, /^ *✓ Read {3}package\.json$/m);
  assert.match(running, /^ *○ Bash {3}npm test · approved$/m);
  assert.doesNotMatch(running, /file\.read|shell\.exec|Running/);

  const settled = terminalFrameText(await renderConversationFrame({
    columns: 70,
    messages: [
      { role: "user", brief: "run the tests" },
      { role: "system", kind: "tool_use", status: "success", id: "tool:1", tool: { verb: "Read", target: "package.json" }, brief: "Read package.json" },
      { role: "system", kind: "tool_use", status: "error", id: "tool:2", tool: { verb: "Bash", target: "npm test", note: "command exited 1" }, brief: "Bash npm test" },
      { role: "assistant", brief: "The tests fail in one place.", footer: { text: "✗ Failed · command exited 1 · Ctrl+O for details", status: "error" } }
    ]
  }));
  assert.match(settled, /^ *▸ Read 1 file, ran 1 command · 1 failed$/m);
  assert.doesNotMatch(settled, /package\.json/);
  assert.match(settled, /^ The tests fail in one place\.$/m);
  assert.match(settled, /^ ✗ Failed · command exited 1 · Ctrl\+O for details$/m);
});

test("the conversation colours only what carries meaning: the turn marker and each call's state", () => {
  const frame = renderTuiToFrame(React.createElement(ConversationFirstPane, {
    messages: [
      { role: "user", brief: "/check the build" },
      { role: "system", kind: "tool_use", status: "running", id: "tool:1", tool: { verb: "Bash", target: "npm test" }, brief: "Bash npm test" },
      { role: "system", kind: "tool_use", status: "success", id: "tool:2", tool: { verb: "Read", target: "README.md" }, brief: "Read README.md" },
      { role: "system", kind: "tool_use", status: "pending", id: "tool:3", tool: { verb: "Write", target: "a.txt", approval: "pending" }, brief: "Write a.txt" },
      { role: "system", kind: "tool_use", status: "error", id: "tool:4", tool: { verb: "Bash", target: "ls nope", note: "command exited 1" }, brief: "Bash ls nope" }
    ],
    rows: 12,
    columns: 72
  }), { columns: 72, rows: 12 });

  const userRow = frameRowWithText(frame, "› /check");
  assert.equal(cellStyleAtText(userRow, "›")?.color, resolveTuiColor("brand.focus"));
  assert.equal(cellStyleAtText(userRow, "/check")?.color, resolveTuiColor("text.primary"));
  assert.equal(cellStyleAtText(userRow, "›")?.backgroundColor, undefined, "no band behind the user's turn");

  assert.equal(cellStyleAtText(frameRowWithText(frame, "npm test"), "○")?.color, resolveTuiColor("status.running"));
  assert.equal(cellStyleAtText(frameRowWithText(frame, "README.md"), "✓")?.color, resolveTuiColor("status.success"));
  assert.equal(cellStyleAtText(frameRowWithText(frame, "a.txt"), "?")?.color, resolveTuiColor("status.pending"));
  const failed = frameRowWithText(frame, "ls nope");
  assert.equal(cellStyleAtText(failed, "✗")?.color, resolveTuiColor("status.danger"));
  assert.equal(cellStyleAtText(failed, "ls nope")?.color, resolveTuiColor("text.primary"));
  assert.equal(cellStyleAtText(failed, "command exited 1")?.color, resolveTuiColor("status.danger"));
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

  const userRow = frameRowWithText(frame, "› select");

  assert.equal(cellStyleAtText(userRow, "›")?.color, resolveTuiColor("brand.focus"));
  assert.equal(cellStyleAtText(userRow, "select")?.color, resolveTuiColor("text.primary"));
  assert.equal(cellStyleAtText(userRow, "›")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(userRow, "select")?.backgroundColor, resolveTuiColor("surface.selection"));
  assert.equal(cellStyleAtText(userRow, "›")?.inverse, undefined);
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

  const userRow = frameRowWithText(frame, "› Find");

  assert.equal(cellStyleAtText(userRow, "›")?.color, resolveTuiColor("brand.focus"));
  assert.equal(cellStyleAtText(userRow, "›")?.backgroundColor, resolveTuiColor("surface.selection"));
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
    bottomRows: 3,
    scrollOffset: 7,
    rows: 10,
    messages: scrolledConversationMessages()
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /Jump to bottom/);
  assert.match(plain, /Jump to bottom ↓/);
  assert.match(plain, /^ *› Ask Swarm$/m);
  assert.equal(plainRows(plain).filter((line) => /^\s*›\s+Keep the default TUI simple\./u.test(line)).length, 1);
});

test("default conversation surface shows new-message pill while scrolled away", async () => {
  const output = await renderConversationFrame({
    bottomRows: 3,
    scrollOffset: 4,
    rows: 10,
    newMessageCount: 2,
    unseenStartIndex: 2
  });
  const plain = terminalFrameText(output);

  assert.match(plain, /2 new messages/);
  assert.match(plain, /2 new messages ↓/);
  assert.match(plain, /── 2 new messages ──/);
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
    bottomRows: 3,
    scrollOffset: 6,
    newMessageCount: 1,
    unseenStartIndex: 2
  });
  const plain = terminalFrameText(output);
  const rows = plainRows(plain);

  assert.match(plain, /1 new message ↓|Jump to bottom ↓/);
  assert(rows.slice(-3).some((line) => line.includes("› Ask Swarm")));
  assert(rows.every((line) => displayWidth(line) <= 58));
});

test("default conversation surface keeps prompt visible when slash completions open on short viewports", async () => {
  const closedOutput = await renderConversationFrame({
    columns: 58,
    rows: 8,
    bottomRows: 3
  });
  const output = await renderConversationFrame({
    columns: 58,
    rows: 8,
    bottomRows: 3,
    completionPlacement: "overlay",
    inputValue: "/"
  });
  const closedPromptRow = promptRowIndex(terminalFrameText(closedOutput));
  const plain = terminalFrameText(output);
  const rows = plainRows(plain);

  assert.doesNotMatch(plain, /Command Palette|COMMAND PALETTE/);
  assert.match(plain, /\/help/);
  assert.equal(promptRowIndex(plain), closedPromptRow);
  assert(rows.slice(-2).some((line) => line.includes("›") || line.includes("/")));
  assert(rows.every((line) => displayWidth(line) <= 58));
});

test("the prompt carries no mode tags: a mode that is not the default shows in the header instead", async () => {
  const plain = terminalFrameText(await renderConversationFrame({ columns: 64, rows: 10, bottomRows: 3 }));
  const promptRow = plainRows(plain).find((line) => line.includes("Ask Swarm")) ?? "";

  assert.equal(promptRow, " › Ask Swarm");
  assert.doesNotMatch(plain, /\[(WORK|RW|ASK|TEAM)\b/);
});

test("the status line sits under the prompt, its hint at the right, and the hint gives way while typing", async () => {
  const status = ({ promptEmpty }: { promptEmpty: boolean }) => React.createElement(StatusLine, {
    ...buildStatusLine({ tickets: { needYou: 2, working: 1 }, spentToday: "$0.13", promptEmpty }),
    columns: 80
  });
  const idle = plainRows(terminalFrameText(await renderConversationFrame({ rows: 12, bottomRows: 3, status })));
  assert.match(idle.at(-1) ?? "", /^ {3}2 tickets need you · \$0\.13 today +\? keys$/);
  assert.equal(idle.at(-2), " › Ask Swarm");

  const typing = plainRows(terminalFrameText(await renderConversationFrame({ rows: 12, bottomRows: 3, status, inputValue: "hello" })));
  assert.match(typing.at(-1) ?? "", /^ {3}2 tickets need you · \$0\.13 today$/, "? would be typed into the prompt, so the hint goes");
});

test("a status-line item opens its view when clicked, and only when the terminal reports the mouse", () => {
  for (const mouse of [true, false]) {
    const clicked: StatusItemId[] = [];
    const root = createTuiRoot({ columns: 100, rows: 3, terminalCapabilities: { mouse } });
    root.render(React.createElement(ChatInputArea, {
      onSubmit: () => undefined,
      onCompletionRowsChange: () => undefined,
      inputActive: false,
      status: ({ promptEmpty }: { promptEmpty: boolean }) => React.createElement(StatusLine, {
        ...buildStatusLine({ approvalsWaiting: 1, tickets: { needYou: 2, working: 0 }, promptEmpty }),
        columns: 100,
        onItemClick: (id: StatusItemId) => clicked.push(id)
      }),
      maxRows: 3
    }));
    try {
      const frame = root.getFrame();
      assert(frame);
      const target = findCell(frame, "2 tickets need you");
      assert(target, "expected the tickets item to render");
      root.dispatchMouse({ x: target.x + 2, y: target.y, button: "left", action: "press" });
      assert.deepEqual(clicked, mouse ? ["tickets"] : []);
    } finally {
      root.unmount();
    }
  }
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
  assert(rows.slice(-2).some((line) => line.includes("› /cap")));
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
  assert(rows.slice(-2).some((line) => line.includes("›") || line.includes("/")));
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

test("while busy the activity line sits between the rule and the prompt, under the transcript", async () => {
  const running = terminalFrameText(await renderConversationFrame({
    rows: 12,
    bottomRows: 4,
    activity: React.createElement(ConversationStatusLine, {
      message: "#4 Running code.test npm test",
      motionFrame: 1,
      elapsedMs: 14_000,
      extra: "2 workers · Ctrl+C interrupts"
    })
  }));
  const rows = plainRows(running);
  assert.match(running, /^ ⠙ Running code\.test npm test · 14s · 2 workers · Ctrl\+C interrupts$/m, "no #turn prefix");
  const activityRow = rows.findIndex((line) => line.includes("Running code.test"));
  assert.match(rows[activityRow - 1] ?? "", /^─+$/);
  assert.equal(rows[activityRow + 1], " › Ask Swarm");
  assert(running.indexOf("Running code.test") > running.indexOf("Done"));
});

test("a settled answer ends with one footer line instead of a result card", async () => {
  const plain = terminalFrameText(await renderConversationFrame({
    messages: [
      { role: "user", brief: "Tidy the layout." },
      { role: "assistant", brief: "Updated the TUI layout.", footer: { text: "2 files changed · 1 check passed", status: "success" } }
    ]
  }));
  const rows = plainRows(plain);
  const answer = rows.findIndex((line) => line === " Updated the TUI layout.");
  assert.equal(rows[answer + 1], " 2 files changed · 1 check passed");
  assert.doesNotMatch(plain, /\[OK\]/);
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

test("the activity line leaves out turn numbers", async () => {
  const plain = terminalFrameText(await renderConversationFrame({
    rows: 12,
    bottomRows: 4,
    activity: React.createElement(ConversationStatusLine, { message: "#12 Swarm is thinking", motionFrame: 2 })
  }));

  assert.match(plain, /⠹ Swarm is thinking/);
  assert.doesNotMatch(plain, /#12|turn\s+12|thinking:/i);
});

async function renderConversationFrame(options: {
  columns?: number;
  bottomRows?: number;
  scrollOffset?: number;
  rows?: number;
  inputValue?: string;
  completionPlacement?: "inline" | "overlay";
  newMessageCount?: number;
  unseenStartIndex?: number;
  messages?: ConversationMessage[];
  workspace?: string;
  activity?: React.ReactNode;
  status?: (input: { promptEmpty: boolean }) => React.ReactNode;
} = {}): Promise<string> {
  const {
    columns = 80,
    bottomRows = 3,
    scrollOffset = 0,
    rows = 20,
    inputValue = "",
    completionPlacement = "inline",
    newMessageCount = 0,
    unseenStartIndex,
    messages = defaultConversationMessages(),
    workspace,
    activity,
    status
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
        unseenStartIndex,
        workspace
      }),
      bottom: React.createElement(ChatInputArea, {
        onSubmit: () => undefined,
        onCompletionRowsChange: () => undefined,
        controllerStateRef: controllerState,
        inputActive: false,
        completionPlacement,
        activity,
        status,
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
    if (line.includes("› ") || line.includes("Ask Swarm")) {
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

test("wrapped transcript rows with inline formatting keep every word", () => {
  const brief = "Filed as a ticket request (847d0f52). A worker takes it in its own directory; replies appear here. Started the ticket host in this TUI; it stops when you quit, or run `swarm superagent run` to keep one going, and **bold** text wraps too.";
  for (const columns of [60, 80, 110]) {
    const frame = renderTuiToFrame(React.createElement(ConversationFirstPane, { messages: [{ role: "system", brief }], rows: 10, columns: columns - 4 }), { columns, rows: 10 });
    const rows = frame.screen.cells.map((row) => row.map((cell) => cell.char).join("").trimEnd()).filter(Boolean);
    const shown = rows.join(" ").replace(/^·\s+/u, "").replace(/\s+/gu, " ");
    const expected = brief.replace(/[`*]/gu, "").replace(/\s+/gu, " ");
    assert.equal(shown.trim(), expected, `at ${columns} columns`);
  }
});
