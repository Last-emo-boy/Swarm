import { strict as assert } from "node:assert";
import test from "node:test";
import {
  conversationMessageFoldKey,
  buildConversationFirstLayout,
  conversationAppendRenderedLineCount,
  conversationActivityLimit,
  conversationBottomRows,
  conversationBottomStatusRows,
  conversationHiddenBelowCount,
  conversationInputCapacity,
  conversationMessageRenderedLineCount,
  conversationNewMessageCountAfterAppend,
  conversationPromptRows,
  conversationRenderedLineCount,
  conversationScrollOffsetAfterAppend,
  conversationTranscriptLimit,
  conversationViewportAfterAppend,
  conversationViewportAfterScroll,
  detailOpenTargetForPane,
  detailTitleForSource,
  fullscreenConversationRows,
  inlineInspectorTargetForPane,
  nextConversationScrollOffset,
  normalizeConversationScrollOffset,
  resetConversationViewport,
  stickyPromptForMessages,
  tuiScreenMode
} from "./conversation-layout.js";
import { displayWidth } from "./display-width.js";
import {
  buildVirtualConversationLayout,
  createConversationRenderCache
} from "./components/VirtualConversationList.js";
import { mainPaneLabels, mainPaneOrder } from "./main-panes.js";
import { statusRailSummary } from "./components/StatusRail.js";

test("conversation-first layout keeps transcript as the default surface", () => {
  const layout = buildConversationFirstLayout({
    messages: [
      { role: "system", brief: "Swarm chat ready." },
      { role: "user", brief: "Simplify the TUI." },
      { role: "assistant", brief: "I will make the default view quieter." }
    ],
    activity: [],
    rows: 24,
    busy: false,
    hasResult: false
  });

  assert.deepEqual(layout.transcript.map((line) => line.text), [
    "Swarm chat ready.",
    "❯ Simplify the TUI.",
    "I will make the default view quieter."
  ]);
  assert.deepEqual(layout.activity, []);
});

test("conversation-first layout renders command and tool transcript rows", () => {
  const layout = buildConversationFirstLayout({
    messages: [
      { role: "user", kind: "command", brief: "/shell npm test" },
      { role: "system", kind: "tool_use", status: "running", brief: "Run shell command: npm test" },
      { role: "system", kind: "tool_result", status: "success", brief: "shell.exec: command exited 0" },
      { role: "assistant", kind: "thinking", status: "running", brief: "Swarm is thinking" }
    ],
    activity: [],
    rows: 12,
    busy: false,
    hasResult: false
  });

  assert.deepEqual(layout.transcript.map((line) => line.text), [
    "❯ /shell npm test",
    "⏵ tool Run shell command: npm test",
    "✓ result shell.exec: command exited 0",
    "∴ think Swarm is thinking"
  ]);
  assert.equal(layout.transcript[1]?.dim, true);
  assert.equal(layout.transcript[3]?.dim, true);
});

test("conversation-first layout keeps activity out of the transcript budget", () => {
  const layout = buildConversationFirstLayout({
    messages: Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      brief: `message ${index}`
    })),
    activity: ["route", "thinking", "read files", "edit file", "run tests"],
    rows: 32,
    busy: true,
    hasResult: false
  });

  assert.equal(layout.transcript.length, conversationTranscriptLimit(32, true, false));
  assert.equal(layout.transcript.length, 32);
  assert.deepEqual(layout.activity, ["run tests"]);
  assert.equal(layout.activityLimit, conversationActivityLimit(32, true, false));
  assert.equal(layout.activityLimit, 1);
});

test("conversation-first layout keeps status and result rows in bottom chrome", () => {
  assert.equal(conversationTranscriptLimit(12, false, true), conversationTranscriptLimit(12, false, false));
  assert.equal(conversationTranscriptLimit(24, false, false), 24);
  assert.equal(conversationTranscriptLimit(24, true, false), 24);
  assert.equal(conversationBottomStatusRows({ busy: true, hasResult: true }), 1);
  assert.equal(conversationBottomStatusRows({ busy: false, hasResult: true }), 2);
  assert.equal(conversationBottomStatusRows({ busy: false, hasResult: false }), 0);
});

test("fullscreen conversation rows leave only bottom input chrome", () => {
  assert.equal(conversationPromptRows(0), 4);
  assert.equal(conversationPromptRows(3), 7);
  assert.equal(fullscreenConversationRows(24, conversationPromptRows(0)), 20);
  assert.equal(fullscreenConversationRows(24, conversationPromptRows(3)), 17);
  assert.equal(fullscreenConversationRows(5, conversationPromptRows(4)), 4);
});

test("fullscreen conversation bottom slot keeps completions out of the prompt budget", () => {
  assert.equal(conversationBottomRows({ terminalRows: 24, contentRows: conversationPromptRows(0) }), 4);
  assert.equal(conversationBottomRows({ terminalRows: 24, contentRows: conversationPromptRows(0) + 20 }), 12);
  assert.equal(conversationBottomRows({ terminalRows: 8, contentRows: conversationPromptRows(0) + 20 }), 4);
  assert.equal(conversationBottomRows({ terminalRows: 20, contentRows: 3, pendingPlan: true }), 3);
  assert.equal(conversationBottomRows({ terminalRows: 20, contentRows: 3, approval: true }), 9);
});

test("conversation input capacity can request multiline height before the bottom slot expands", () => {
  assert.deepEqual(conversationInputCapacity({ bottomRows: conversationPromptRows(0) }), {
    maxCompletionRows: 1,
    maxInputRows: 4
  });
});

test("conversation-first layout does not inline command details into the default transcript", () => {
  const layout = buildConversationFirstLayout({
    messages: [{
      role: "system",
      brief: "3 recent tool outputs. Ctrl+O for details.",
      detail: "tool output line 1\ntool output line 2\ntool output line 3",
      preview: "tool output line 1"
    }],
    activity: ["tool read completed", "tool grep completed", "tool test completed", "tool lint completed"],
    rows: 20,
    busy: false,
    hasResult: false
  });

  assert.deepEqual(layout.transcript.map((line) => line.text), ["3 recent tool outputs. Ctrl+O for details."]);
  assert(!layout.transcript.some((line) => line.text.includes("tool output line")));
  assert.deepEqual(layout.activity, []);
});

test("conversation-first layout renders assistant markdown and preserves newlines", () => {
  const layout = buildConversationFirstLayout({
    messages: [{
      role: "assistant",
      brief: "Finished.",
      detail: [
        "Result",
        "Summary: ignored in chat surface",
        "",
        "Full Output",
        "# Done",
        "First line",
        "Second line",
        "",
        "- item one",
        "- item two",
        "",
        "```ts",
        "const value = 1;",
        "```"
      ].join("\n")
    }],
    activity: [],
    rows: 24,
    busy: false,
    hasResult: false
  });

  assert.deepEqual(layout.transcript.map((line) => line.text), [
    "Done",
    "First line",
    "Second line",
    "",
    "- item one",
    "- item two",
    "",
    "[ts]",
    "  const value = 1;"
  ]);
  assert.equal(layout.transcript[0]?.kind, "heading");
  assert.equal(layout.transcript[8]?.kind, "code");
});

test("conversation-first layout pre-wraps long markdown lines by terminal width", () => {
  const longLine = "This is a long assistant paragraph that should wrap before Ink has to compress it into one terminal row.";
  const layout = buildConversationFirstLayout({
    messages: [{ role: "assistant", brief: longLine }],
    activity: [],
    rows: 12,
    columns: 34,
    busy: false,
    hasResult: false
  });

  assert(layout.transcript.length > 1);
  assert(layout.transcript.every((line) => line.text.length <= 34));
  assert.equal(conversationMessageRenderedLineCount({ role: "assistant", brief: longLine }, 34), layout.transcript.length);
  assert.equal(conversationRenderedLineCount([{ role: "assistant", brief: longLine }], 34), layout.transcript.length);
});

test("conversation-first layout wraps CJK text by terminal cell width", () => {
  const layout = buildConversationFirstLayout({
    messages: [{ role: "assistant", brief: "这是一个很长的中文输出段落，用来验证终端宽字符不会把布局挤坏。" }],
    activity: [],
    rows: 12,
    columns: 20,
    busy: false,
    hasResult: false
  });

  assert(layout.transcript.length > 3);
  assert(layout.transcript.every((line) => displayWidth(line.text) <= 20));
});

test("conversation-first markdown rendering keeps technical identifiers intact", () => {
  const layout = buildConversationFirstLayout({
    messages: [{
      role: "assistant",
      brief: "Done.",
      detail: "Use `worker_loop_state` and keep foo_bar_baz unchanged."
    }],
    activity: [],
    rows: 12,
    busy: false,
    hasResult: false
  });

  assert.deepEqual(layout.transcript.map((line) => line.text), [
    "Use worker_loop_state and keep foo_bar_baz unchanged."
  ]);
});

test("conversation-first markdown rendering keeps tables and dividers readable", () => {
  const layout = buildConversationFirstLayout({
    messages: [{
      role: "assistant",
      brief: [
        "| Area | Status |",
        "| --- | --- |",
        "| TUI | Done |",
        "",
        "---",
        "",
        "Next"
      ].join("\n")
    }],
    activity: [],
    rows: 16,
    busy: false,
    hasResult: false
  });

  assert.deepEqual(layout.transcript.map((line) => line.text), [
    "Area  Status",
    "---  ---",
    "TUI  Done",
    "",
    "---",
    "",
    "Next"
  ]);
  assert.equal(layout.transcript[0]?.kind, "table");
  assert.equal(layout.transcript[1]?.kind, "table");
  assert.equal(layout.transcript[4]?.kind, "divider");
});

test("conversation-first layout crops by rendered line budget instead of message count", () => {
  const detail = [
    "Result",
    "",
    "Full Output",
    ...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
  ].join("\n");
  const layout = buildConversationFirstLayout({
    messages: [{ role: "assistant", brief: "Long output.", detail }],
    activity: [],
    rows: 8,
    busy: false,
    hasResult: false
  });

  assert.equal(layout.transcript.length, conversationTranscriptLimit(8, false, false));
  assert.equal(layout.transcript[0]?.text, "line 13");
  assert(layout.transcript.at(-1)?.text.includes("line 20"));
});

test("conversation-first transcript supports scrollback windows", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    brief: `line ${index + 1}`
  }));
  const pinned = buildConversationFirstLayout({
    messages,
    activity: [],
    rows: 6,
    busy: false,
    hasResult: false,
    scrollOffset: 0
  });
  assert.equal(pinned.scrollOffset, 0);
  assert.equal(pinned.hiddenBelow, 0);
  assert(pinned.transcript.at(-1)?.text.includes("line 20"));

  const scrolled = buildConversationFirstLayout({
    messages,
    activity: [],
    rows: 6,
    busy: false,
    hasResult: false,
    scrollOffset: 6
  });
  assert.equal(scrolled.scrollOffset, 6);
  assert.equal(scrolled.hiddenBelow, 6);
  assert.equal(scrolled.stickyPrompt, undefined);
  assert.equal(scrolled.bottomPill, "Jump to bottom");
  assert.equal(scrolled.transcript.length, 6);
  assert(scrolled.transcript[0]?.text.includes("line 9"));
  assert(scrolled.transcript.at(-1)?.text.includes("line 14"));
  assert(!scrolled.transcript.some((line) => line.text.includes("transcript line")));
});

test("conversation scrollback exposes cc-style sticky prompt and bottom pill", () => {
  const messages = [
    { role: "system" as const, brief: "Ready." },
    { role: "user" as const, brief: "Please make the TUI look like Claude Code.\nKeep it simple." },
    {
      role: "assistant" as const,
      brief: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")
    }
  ];

  const pinned = buildConversationFirstLayout({
    messages,
    activity: [],
    rows: 5,
    busy: false,
    hasResult: false,
    scrollOffset: 0
  });
  assert.equal(pinned.stickyPrompt, undefined);
  assert.equal(pinned.bottomPill, undefined);

  const scrolled = buildConversationFirstLayout({
    messages,
    activity: [],
    rows: 6,
    busy: false,
    hasResult: false,
    scrollOffset: 4
  });
  assert.equal(scrolled.stickyPrompt, "Please make the TUI look like Claude Code. Keep it simple.");
  assert.equal(scrolled.bottomPill, "Jump to bottom");
  assert.equal(stickyPromptForMessages(messages), "Please make the TUI look like Claude Code. Keep it simple.");
});

test("conversation scrollback pill counts new assistant messages instead of rendered lines", () => {
  const messages = [
    { role: "user" as const, brief: "Prompt" },
    {
      role: "assistant" as const,
      brief: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")
    }
  ];
  const layout = buildConversationFirstLayout({
    messages,
    activity: [],
    rows: 6,
    busy: false,
    hasResult: false,
    scrollOffset: 4,
    newMessageCount: 2
  });

  assert.equal(layout.bottomPill, "2 new messages");
});

test("conversation scrollback inserts an in-transcript new messages divider", () => {
  const messages = [
    { role: "user" as const, brief: "Old prompt" },
    {
      role: "assistant" as const,
      brief: Array.from({ length: 8 }, (_, index) => `old answer ${index + 1}`).join("\n")
    },
    { role: "assistant" as const, brief: "Fresh answer" },
    { role: "system" as const, brief: "Fresh note" }
  ];
  const layout = buildConversationFirstLayout({
    messages,
    activity: [],
    rows: 8,
    busy: false,
    hasResult: false,
    scrollOffset: 1,
    unseenStartIndex: 2,
    newMessageCount: 2
  });

  const dividerIndex = layout.transcript.findIndex((line) => line.kind === "divider");
  assert(dividerIndex >= 0);
  assert.equal(layout.transcript[dividerIndex]?.text, "--- 2 new messages ---");
  assert(layout.transcript.some((line) => line.text.includes("Fresh answer")));
  assert.equal(layout.hiddenBelow, 1);
  assert(!layout.transcript.some((line) => line.text.includes("transcript line")));
  assert.equal(layout.bottomPill, "2 new messages");
});

test("conversation divider stays anchored to the first unseen message after wrapping", () => {
  const layout = buildConversationFirstLayout({
    messages: [
      { role: "user", brief: "old" },
      {
        role: "assistant",
        brief: "This is the first unseen answer and it is long enough to wrap across several terminal rows."
      }
    ],
    activity: [],
    rows: 12,
    columns: 32,
    busy: false,
    hasResult: false,
    scrollOffset: 1,
    unseenStartIndex: 1,
    newMessageCount: 1
  });
  const dividerIndex = layout.transcript.findIndex((line) => line.kind === "divider");
  const firstFreshIndex = layout.transcript.findIndex((line) => line.text.includes("This is the first"));

  assert(dividerIndex >= 0);
  assert(firstFreshIndex > dividerIndex);
  assert.equal(layout.transcript[dividerIndex]?.text, "--- 1 new message ---");
});

test("conversation sticky prompt is hidden while the prompt row is visible", () => {
  const messages = [
    { role: "user" as const, brief: "Old prompt" },
    {
      role: "assistant" as const,
      brief: Array.from({ length: 8 }, (_, index) => `old line ${index + 1}`).join("\n")
    },
    { role: "user" as const, brief: "Visible prompt" },
    { role: "assistant" as const, brief: "short answer" }
  ];
  const layout = buildConversationFirstLayout({
    messages,
    activity: [],
    rows: 6,
    busy: false,
    hasResult: false,
    scrollOffset: 1
  });

  assert.equal(layout.stickyPrompt, undefined);
  assert.equal(layout.bottomPill, "Jump to bottom");
  assert(layout.transcript.some((line) => line.text.includes("Visible prompt")));
});

test("conversation scroll offsets clamp to available history", () => {
  assert.equal(normalizeConversationScrollOffset(20, 6, 999), 14);
  assert.equal(normalizeConversationScrollOffset(20, 6, -2), 0);
  assert.equal(nextConversationScrollOffset({ totalLines: 20, viewportLines: 6, currentOffset: 0, delta: 8 }), 8);
  assert.equal(nextConversationScrollOffset({ totalLines: 20, viewportLines: 6, currentOffset: 8, delta: -20 }), 0);
  assert.equal(conversationHiddenBelowCount({ totalLines: 20, viewportLines: 6, scrollOffset: 8 }), 8);
  assert.equal(conversationHiddenBelowCount({ totalLines: 20, viewportLines: 6, scrollOffset: 999 }), 14);
});

test("conversation scroll follows bottom but preserves scrolled history on append", () => {
  assert.equal(conversationScrollOffsetAfterAppend(0, 3), 0);
  assert.equal(conversationScrollOffsetAfterAppend(6, 3), 9);
  assert.equal(conversationScrollOffsetAfterAppend(6, -2), 6);
});

test("conversation append line count includes the unseen divider when a new section starts", () => {
  const message = { role: "assistant" as const, brief: "fresh answer" };
  assert.equal(conversationAppendRenderedLineCount({ message }), conversationMessageRenderedLineCount(message));
  assert.equal(
    conversationAppendRenderedLineCount({ message, startsUnseenSection: true }),
    conversationMessageRenderedLineCount(message) + 1
  );
});

test("conversation new-message count follows cc-style assistant-turn semantics", () => {
  assert.equal(conversationNewMessageCountAfterAppend({
    currentOffset: 0,
    currentCount: 0,
    message: { role: "assistant", brief: "answer" }
  }), 0);
  assert.equal(conversationNewMessageCountAfterAppend({
    currentOffset: 4,
    currentCount: 0,
    message: { role: "assistant", brief: "answer" }
  }), 1);
  assert.equal(conversationNewMessageCountAfterAppend({
    currentOffset: 4,
    currentCount: 1,
    message: { role: "assistant", brief: "next answer" }
  }), 2);
  assert.equal(conversationNewMessageCountAfterAppend({
    currentOffset: 4,
    currentCount: 2,
    message: { role: "system", kind: "progress", brief: "still working" }
  }), 2);
  assert.equal(conversationNewMessageCountAfterAppend({
    currentOffset: 4,
    currentCount: 2,
    message: { role: "system", kind: "tool_result", brief: "shell done" }
  }), 2);
  assert.equal(conversationNewMessageCountAfterAppend({
    currentOffset: 4,
    currentCount: 2,
    message: { role: "assistant", kind: "thinking", brief: "Thinking" }
  }), 2);
  assert.equal(conversationNewMessageCountAfterAppend({
    currentOffset: 4,
    currentCount: 2,
    message: { role: "user", brief: "new prompt" }
  }), 0);
});

test("conversation viewport state tracks unseen baseline while scrolled away", () => {
  const initial = { scrollOffset: 4, newMessageCount: 0, unseenStartIndex: undefined };
  const first = conversationViewportAfterAppend({
    state: initial,
    message: { role: "assistant", brief: "fresh answer" },
    messageIndex: 3
  });
  assert.deepEqual(first, {
    scrollOffset: 6,
    newMessageCount: 1,
    unseenStartIndex: 3
  });

  const second = conversationViewportAfterAppend({
    state: first,
    message: { role: "system", brief: "fresh note" },
    messageIndex: 4
  });
  assert.deepEqual(second, {
    scrollOffset: 7,
    newMessageCount: 1,
    unseenStartIndex: 3
  });

  assert.deepEqual(conversationViewportAfterAppend({
    state: second,
    message: { role: "user", brief: "new prompt" },
    messageIndex: 5
  }), resetConversationViewport());
});

test("conversation viewport state clears unseen baseline when scrolled to bottom", () => {
  const state = { scrollOffset: 4, newMessageCount: 2, unseenStartIndex: 3 };
  assert.deepEqual(conversationViewportAfterScroll({
    state,
    totalLines: 20,
    viewportLines: 8,
    delta: -10
  }), resetConversationViewport());

  assert.deepEqual(conversationViewportAfterScroll({
    state,
    totalLines: 20,
    viewportLines: 8,
    delta: 3
  }), {
    scrollOffset: 7,
    newMessageCount: 2,
    unseenStartIndex: 3
  });
});

test("virtual conversation layout mounts only visible long-session messages", () => {
  const messages = Array.from({ length: 1000 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    brief: `message ${index}`
  }));
  const cache = createConversationRenderCache();
  const layout = buildVirtualConversationLayout({
    messages,
    rows: 12,
    columns: 80,
    scrollOffset: 0,
    cache
  });

  assert.equal(layout.transcript.length, 12);
  assert(layout.visibleMessageCount <= 12);
  assert(layout.mountedMessageCount < 20);
  assert(layout.transcript.at(-1)?.text.includes("message 999"));
  assert.equal(cache.stats().misses, 1000);

  cache.resetStats();
  const appended = buildVirtualConversationLayout({
    messages: [...messages, { role: "assistant", brief: "fresh tail" }],
    rows: 12,
    columns: 80,
    scrollOffset: 0,
    cache
  });
  assert.equal(appended.transcript.at(-1)?.text, "fresh tail");
  assert.equal(cache.stats().misses, 1);
  assert(cache.stats().hits >= 1000);
});

test("virtual conversation render cache invalidates width-sensitive wrapping", () => {
  const cache = createConversationRenderCache();
  const messages = [{
    role: "assistant" as const,
    brief: "This assistant paragraph is long enough to wrap differently across terminal widths."
  }];

  const narrow = buildVirtualConversationLayout({ messages, rows: 12, columns: 24, cache });
  assert(narrow.transcript.length > 1);
  assert.equal(cache.stats().misses, 1);

  cache.resetStats();
  const narrowAgain = buildVirtualConversationLayout({ messages, rows: 12, columns: 24, cache });
  assert.equal(narrowAgain.transcript.length, narrow.transcript.length);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 0);

  cache.resetStats();
  const wide = buildVirtualConversationLayout({ messages, rows: 12, columns: 80, cache });
  assert(wide.transcript.length < narrow.transcript.length);
  assert.equal(cache.stats().misses, 1);
});

test("virtual conversation layout separates compact and expanded fold cache entries", () => {
  const cache = createConversationRenderCache();
  const messages = [{
    role: "system" as const,
    kind: "tool_result" as const,
    status: "success" as const,
    brief: "shell.exec: command exited 0",
    preview: "shell.exec: command exited 0\nshort",
    detail: "shell.exec: command exited 0\nshort\nfull output line"
  }];

  const compact = buildVirtualConversationLayout({ messages, rows: 8, columns: 80, cache });
  assert.equal(compact.transcript.length, 1);
  assert.doesNotMatch(compact.transcript.map((line) => line.text).join("\n"), /full output line/);

  cache.resetStats();
  const expanded = buildVirtualConversationLayout({
    messages,
    rows: 8,
    columns: 80,
    expandedMessageKeys: new Set([conversationMessageFoldKey(messages[0]!, 0)]),
    cache
  });
  assert.match(expanded.transcript.map((line) => line.text).join("\n"), /full output line/);
  assert.equal(cache.stats().misses, 1);

  cache.resetStats();
  const expandedAgain = buildVirtualConversationLayout({
    messages,
    rows: 8,
    columns: 80,
    expandedMessageKeys: new Set([conversationMessageFoldKey(messages[0]!, 0)]),
    cache
  });
  assert.match(expandedAgain.transcript.map((line) => line.text).join("\n"), /full output line/);
  assert.equal(cache.stats().hits, 1);
});

test("main pane order makes chat default and keeps trace available", () => {
  assert.equal(mainPaneOrder[0], "chat");
  assert.equal(mainPaneLabels.chat, "Chat");
  assert.equal(mainPaneLabels.log, "Trace");
  assert(mainPaneOrder.includes("log"));
});

test("detail open target keeps chat and trace shortcuts separate", () => {
  assert.equal(detailOpenTargetForPane({ pane: "chat", actionCount: 10, hasLatestDetail: true }), "latest");
  assert.equal(detailOpenTargetForPane({ pane: "log", actionCount: 10, hasLatestDetail: true }), "selected-action");
  assert.equal(detailOpenTargetForPane({ pane: "chat", actionCount: 10, hasLatestDetail: false }), "none");
});

test("inline inspector avoids command-output chrome unless real command detail is selected", () => {
  assert.deepEqual(inlineInspectorTargetForPane({
    pane: "overview",
    selectedAction: true,
    latestDetailSource: "none",
    latestDetail: false
  }), {
    enabled: false,
    source: "event",
    title: "Inspector"
  });

  assert.deepEqual(inlineInspectorTargetForPane({
    pane: "log",
    selectedAction: true,
    latestDetailSource: "none",
    latestDetail: false
  }), {
    enabled: true,
    source: "event",
    title: "Trace Detail"
  });

  assert.deepEqual(inlineInspectorTargetForPane({
    pane: "overview",
    selectedAction: false,
    latestDetailSource: "command",
    latestDetail: true
  }), {
    enabled: false,
    source: "event",
    title: "Inspector"
  });

  assert.deepEqual(inlineInspectorTargetForPane({
    pane: "overview",
    selectedAction: false,
    latestDetailSource: "ai",
    latestDetail: true
  }), {
    enabled: true,
    source: "ai",
    title: "Assistant Detail"
  });

  assert.equal(detailTitleForSource("command"), "Command Output");
  assert.equal(detailTitleForSource("command", true), "Latest Output");
  assert.equal(detailTitleForSource("event", true), "Trace Detail");
});

test("chat status rail hides operator metadata unless it is actionable", () => {
  const idle = statusRailSummary({
    appName: "Swarm",
    state: "idle",
    route: "auto",
    permissionMode: "ask",
    sandboxMode: "workspace-write",
    model: "openai/gpt",
    view: "Chat",
    compact: true
  });
  assert.deepEqual(idle, {
    showRoute: false,
    showPermission: false,
    showSandbox: false,
    showModel: false,
    details: []
  });

  const trace = statusRailSummary({
    appName: "Swarm",
    state: "idle",
    route: "auto",
    permissionMode: "ask",
    sandboxMode: "workspace-write",
    model: "openai/gpt",
    view: "Trace",
    compact: false
  });
  assert.equal(trace.showRoute, true);
  assert.equal(trace.showPermission, true);
  assert.equal(trace.showSandbox, true);
  assert.equal(trace.showModel, true);
  assert.deepEqual(trace.details, ["Trace"]);
});

test("chat status rail shows approval metadata when user action is needed", () => {
  const approval = statusRailSummary({
    appName: "Swarm",
    state: "awaiting approval",
    route: "swarm",
    permissionMode: "ask",
    sandboxMode: "read-only",
    model: "openai/gpt",
    sessionId: "session-123456789",
    view: "Chat",
    compact: true
  });

  assert.equal(approval.showRoute, true);
  assert.equal(approval.showPermission, false);
  assert.equal(approval.showSandbox, true);
  assert.equal(approval.showModel, false);
  assert.deepEqual(approval.details, ["session session-"]);
});

test("screen mode keeps the default TUI conversation-first", () => {
  assert.deepEqual(tuiScreenMode({
    pane: "chat",
    columns: 160,
    busy: false,
    hasApproval: false,
    hasPendingPlan: false
  }), {
    compactStatus: true,
    showCurrentAction: false,
    showInspector: false,
    primarySurface: "conversation"
  });

  assert.deepEqual(tuiScreenMode({
    pane: "log",
    columns: 160,
    busy: false,
    hasApproval: false,
    hasPendingPlan: false
  }), {
    compactStatus: false,
    showCurrentAction: false,
    showInspector: true,
    primarySurface: "trace"
  });
});
