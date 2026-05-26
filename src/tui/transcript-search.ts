import type { ConversationMessage } from "./conversation-layout.js";

export type TranscriptSearchIndexEntry = {
  message: ConversationMessage;
  messageIndex: number;
  text: string;
};

export type TranscriptSearchIndex = {
  entries: TranscriptSearchIndexEntry[];
};

export type TranscriptSearchMatch = {
  messageIndex: number;
  start: number;
  end: number;
};

export type TranscriptSearchState = {
  active: boolean;
  query: string;
  matches: TranscriptSearchMatch[];
  currentIndex: number;
};

export function createTranscriptSearchState(): TranscriptSearchState {
  return {
    active: false,
    query: "",
    matches: [],
    currentIndex: -1
  };
}

export function buildTranscriptSearchIndex(messages: readonly ConversationMessage[]): TranscriptSearchIndex {
  return {
    entries: messages.map((message, messageIndex) => ({
      message,
      messageIndex,
      text: transcriptSearchText(message).toLowerCase()
    }))
  };
}

export function updateTranscriptSearch(
  previous: TranscriptSearchState,
  index: TranscriptSearchIndex,
  query: string
): TranscriptSearchState {
  const normalized = query.toLowerCase().trim();
  if (!normalized) {
    return { active: true, query, matches: [], currentIndex: -1 };
  }
  const matches = searchTranscriptIndex(index, normalized);
  const preferredMessage = previous.matches[previous.currentIndex]?.messageIndex;
  const preferredIndex = preferredMessage === undefined
    ? 0
    : Math.max(0, matches.findIndex((match) => match.messageIndex >= preferredMessage));
  return {
    active: true,
    query,
    matches,
    currentIndex: matches.length ? preferredIndex : -1
  };
}

export function refreshTranscriptSearch(
  previous: TranscriptSearchState,
  index: TranscriptSearchIndex
): TranscriptSearchState {
  if (!previous.active) {
    return previous;
  }
  return updateTranscriptSearch(previous, index, previous.query);
}

export function stepTranscriptSearch(state: TranscriptSearchState, delta: number): TranscriptSearchState {
  if (!state.matches.length) {
    return { ...state, currentIndex: -1 };
  }
  const next = (state.currentIndex + delta + state.matches.length) % state.matches.length;
  return { ...state, currentIndex: next };
}

export function closeTranscriptSearch(state: TranscriptSearchState): TranscriptSearchState {
  return { ...state, active: false };
}

export function currentTranscriptSearchMatch(state: TranscriptSearchState): TranscriptSearchMatch | undefined {
  return state.matches[state.currentIndex];
}

export function transcriptSearchSummary(state: TranscriptSearchState): string | undefined {
  if (!state.active) {
    return undefined;
  }
  if (!state.query.trim()) {
    return "search";
  }
  if (!state.matches.length) {
    return `search 0/${state.query}`;
  }
  return `search ${state.currentIndex + 1}/${state.matches.length} ${state.query}`;
}

function searchTranscriptIndex(index: TranscriptSearchIndex, query: string): TranscriptSearchMatch[] {
  const matches: TranscriptSearchMatch[] = [];
  for (const entry of index.entries) {
    let start = entry.text.indexOf(query);
    while (start >= 0) {
      matches.push({
        messageIndex: entry.messageIndex,
        start,
        end: start + query.length
      });
      start = entry.text.indexOf(query, start + Math.max(1, query.length));
    }
  }
  return matches;
}

function transcriptSearchText(message: ConversationMessage): string {
  const base = [
    message.role,
    message.kind,
    message.status,
    message.title,
    message.brief,
    message.preview,
    message.detail
  ].filter(Boolean).join("\n");
  return [
    base,
    ...transcriptSearchAliases(base)
  ].filter(Boolean).join("\n");
}

function transcriptSearchAliases(text: string): string[] {
  const lower = text.toLowerCase();
  const aliases: string[] = [];
  if (/\berror\b|\bfailed\b|\bfailure\b/u.test(lower)) {
    aliases.push("failed failure error");
  }
  if (/\bwarning\b|\bwarn\b|\bdegraded\b|\bpartial\b/u.test(lower)) {
    aliases.push("warning warn degraded partial");
  }
  if (/\bcache_miss\b|\bprefix_drift\b|\bprompt cache\b|\bcached_input_tokens\b/u.test(lower)) {
    aliases.push("cache miss prompt cache cache_miss");
  }
  if (/\blsp\b|\bfallback_reason\b|\bfallback_reasons\b|\bsemantic fallback\b/u.test(lower)) {
    aliases.push("lsp fallback semantic fallback");
  }
  if (/\bgateway\b|\bsymphony\b|\blive_control\b|\boperator action\b|\bnot_supported\b/u.test(lower)) {
    aliases.push("gateway action symphony control live_control");
  }
  const actionId = lower.match(/\b(action|message|task|session|correlation)[_-]?id[=:]\s*([a-z0-9._:-]+)/u);
  if (actionId?.[2]) {
    aliases.push(`action id ${actionId[2]}`);
  }
  return aliases;
}
