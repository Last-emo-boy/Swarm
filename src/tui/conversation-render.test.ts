import { strict as assert } from "node:assert";
import { PassThrough } from "node:stream";
import React from "react";
import test from "node:test";
import { render } from "ink";
import { ChatCommandCandidates, ChatInputArea } from "./ChatInputArea.js";
import { ConversationFirstPane } from "./components/ConversationFirstPane.js";
import { ConversationBottomChrome, ConversationFullscreenLayout } from "./components/ConversationFullscreenLayout.js";
import { chatInputCompletionCandidates, createChatInputControllerState, selectedChatInputCompletionIndex } from "./chat-input-controller.js";
import { displayWidth } from "./display-width.js";
import type { ConversationMessage } from "./conversation-layout.js";
import type { ResultCard } from "../runtime/result-card.js";

test("default conversation surface renders without dashboard chrome", async () => {
  const output = await renderConversationFrame();
  const plain = stripAnsi(output);

  assert.match(plain, /Swarm chat ready/);
  assert.match(plain, /❯ Keep the default TUI simple/);
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
  const plain = stripAnsi(output);

  assert.match(plain, /Symphony Swarm/);
  assert.match(plain, /Local Agent OS|openai\/gpt/);
  assert.match(plain, /E:\\Playground\\Swarm/);
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
  const plain = stripAnsi(output);

  assert.match(plain, /❯ \/shell npm test/);
  assert.match(plain, /Run shell command: npm test/);
  assert.match(plain, /shell\.exec: command exited 0/);
  assert.doesNotMatch(plain, /\$ npm test/);
  assert.match(plain, /Swarm is thinking/);
});

test("default conversation surface keeps multiline prompt visible at the bottom", async () => {
  const output = await renderConversationFrame({
    inputValue: "line one\nline two\nline three",
    bottomRows: 6
  });
  const plain = stripAnsi(output);

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
  const plain = stripAnsi(output);

  assert.match(plain, /Jump to bottom/);
  assert.match(plain, /Jump to bottom ↓/);
  assert.match(plain, /^\s*❯/m);
  assert.equal(plainRows(plain).filter((line) => line.includes("❯ Keep the default TUI simple.")).length, 1);
});

test("default conversation surface shows new-message pill while scrolled away", async () => {
  const output = await renderConversationFrame({
    bottomRows: 4,
    scrollOffset: 4,
    rows: 10,
    newMessageCount: 2,
    unseenStartIndex: 2
  });
  const plain = stripAnsi(output);

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
  const plain = stripAnsi(output);

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
  const plain = stripAnsi(output);
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
  const closedPromptRow = promptRowIndex(stripAnsi(closedOutput));
  const plain = stripAnsi(output);
  const rows = plainRows(plain);

  assert.doesNotMatch(plain, /Command Palette|COMMAND PALETTE/);
  assert.match(plain, /\/help/);
  assert.equal(promptRowIndex(plain), closedPromptRow);
  assert(rows.slice(-2).some((line) => line.includes("❯") || line.includes("/")));
  assert(rows.every((line) => displayWidth(line) <= 58));
});

test("slash completion overlay centers the selected command without title chrome", async () => {
  const output = await renderConversationFrame({
    columns: 72,
    rows: 12,
    bottomRows: 4,
    completionPlacement: "overlay",
    inputValue: "/cap"
  });
  const plain = stripAnsi(output);
  const rows = plainRows(plain);

  assert.doesNotMatch(plain, /Command Palette|COMMAND PALETTE|Up\/Down select/);
  assert.match(plain, /\/capabilities/);
  assert(rows.some((line) => line.trimStart().startsWith("› /capabilities")));
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
  const plain = stripAnsi(output);
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
  const plain = stripAnsi(output);

  assert.match(plain, /Report/);
  assert.match(plain, /Area\s+Status/);
  assert.match(plain, /const viewport = 'conversation-first';/);
  assert(plainRows(plain).filter((line) => line.includes("This paragraph")).length <= 1);
  assert(plainRows(plain).every((line) => displayWidth(line) <= 64));
});

test("default conversation surface keeps activity and result in fixed bottom chrome", async () => {
  const running = stripAnsi(await renderConversationFrame({
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

  const completed = stripAnsi(await renderConversationFrame({
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
  const plain = stripAnsi(output);

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
            maxRows: Math.max(1, bottomRows - (bottomChrome.busy ? 1 : bottomChrome.resultCard ? 2 : 0))
          })
        })
        : React.createElement(ChatInputArea, {
          onSubmit: () => undefined,
          onCompletionRowsChange: () => undefined,
          controllerStateRef: controllerState,
          inputActive: false,
          completionPlacement,
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

function plainRows(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
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
