import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  buildVirtualConversationLayout,
  createConversationRenderCache
} from "../tui/components/VirtualConversationList.js";
import type { ConversationMessage } from "../tui/conversation-layout.js";

export type TuiLongSessionBenchResult = {
  messages: number;
  initialMs: number;
  appendMs: number;
  initialMountedMessages: number;
  appendedMountedMessages: number;
  appendCacheHits: number;
  appendCacheMisses: number;
};

export function runTuiLongSessionBench(count = 2000): TuiLongSessionBenchResult {
  const messages = longConversationMessages(count);
  const cache = createConversationRenderCache();
  const initialStart = performance.now();
  const initial = buildVirtualConversationLayout({
    messages,
    rows: 24,
    columns: 100,
    scrollOffset: 0,
    cache
  });
  const initialMs = performance.now() - initialStart;

  cache.resetStats();
  const appendStart = performance.now();
  const appended = buildVirtualConversationLayout({
    messages: [...messages, { role: "assistant", brief: "fresh appended tail" }],
    rows: 24,
    columns: 100,
    scrollOffset: 0,
    cache
  });
  const appendMs = performance.now() - appendStart;
  const appendStats = cache.stats();

  return {
    messages: count,
    initialMs,
    appendMs,
    initialMountedMessages: initial.mountedMessageCount,
    appendedMountedMessages: appended.mountedMessageCount,
    appendCacheHits: appendStats.hits,
    appendCacheMisses: appendStats.misses
  };
}

function longConversationMessages(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    brief: `${index % 2 === 0 ? "prompt" : "assistant response"} ${index}`
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(runTuiLongSessionBench(), null, 2));
}
