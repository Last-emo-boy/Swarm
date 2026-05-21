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
  return [
    message.role,
    message.kind,
    message.title,
    message.brief,
    message.preview,
    message.detail
  ].filter(Boolean).join("\n");
}
