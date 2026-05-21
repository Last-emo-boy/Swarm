export type ScrollClampBounds = {
  min?: number;
  max?: number;
};

export type ScrollDomState = {
  scrollTop: number;
  pendingDelta: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportTop: number;
  sticky: boolean;
  clamp: ScrollClampBounds;
};

export type ScrollDomSnapshot = Readonly<ScrollDomState> & {
  maxScrollTop: number;
};

export function createScrollDomState(input: Partial<ScrollDomState> = {}): ScrollDomState {
  const state: ScrollDomState = {
    scrollTop: sanitizeRow(input.scrollTop ?? 0),
    pendingDelta: sanitizeRow(input.pendingDelta ?? 0),
    scrollHeight: sanitizeRow(input.scrollHeight ?? 0),
    viewportHeight: Math.max(0, sanitizeRow(input.viewportHeight ?? 0)),
    viewportTop: sanitizeRow(input.viewportTop ?? 0),
    sticky: Boolean(input.sticky),
    clamp: { ...input.clamp }
  };
  state.scrollTop = clampScrollTop(state, state.scrollTop);
  return state;
}

export function scrollSnapshot(state: ScrollDomState): ScrollDomSnapshot {
  return Object.freeze({
    scrollTop: state.scrollTop,
    pendingDelta: state.pendingDelta,
    scrollHeight: state.scrollHeight,
    viewportHeight: state.viewportHeight,
    viewportTop: state.viewportTop,
    sticky: state.sticky,
    clamp: Object.freeze({ ...state.clamp }),
    maxScrollTop: maxScrollTop(state)
  });
}

export function sanitizeRow(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.floor(value);
}

export function maxScrollTop(state: Pick<ScrollDomState, "scrollHeight" | "viewportHeight">): number {
  return Math.max(0, sanitizeRow(state.scrollHeight) - Math.max(0, sanitizeRow(state.viewportHeight)));
}

export function clampScrollTop(
  state: Pick<ScrollDomState, "scrollHeight" | "viewportHeight" | "clamp">,
  value: number
): number {
  const max = maxScrollTop(state);
  const clampMin = state.clamp.min === undefined ? 0 : sanitizeRow(state.clamp.min);
  const clampMax = state.clamp.max === undefined ? max : sanitizeRow(state.clamp.max);
  const upper = Math.max(0, Math.min(max, clampMax));
  const lower = Math.max(0, Math.min(clampMin, upper));
  return Math.max(lower, Math.min(upper, sanitizeRow(value)));
}

