import {
  clampScrollTop,
  maxScrollTop,
  sanitizeRow,
  type ScrollClampBounds,
  type ScrollDomSnapshot,
  type ScrollDomState
} from "./dom.js";

export type ScrollMetrics = {
  scrollHeight?: number;
  viewportHeight?: number;
  viewportTop?: number;
};

export type ScrollWindow = {
  start: number;
  end: number;
  committedStart: number;
  committedEnd: number;
  pendingStart: number;
  pendingEnd: number;
  hiddenAbove: number;
  hiddenBelow: number;
  atTop: boolean;
  atBottom: boolean;
};

export function applyScrollMetrics(state: ScrollDomState, metrics: ScrollMetrics): boolean {
  const previous = snapshotSignature(state);
  if (metrics.scrollHeight !== undefined) {
    state.scrollHeight = Math.max(0, sanitizeRow(metrics.scrollHeight));
  }
  if (metrics.viewportHeight !== undefined) {
    state.viewportHeight = Math.max(0, sanitizeRow(metrics.viewportHeight));
  }
  if (metrics.viewportTop !== undefined) {
    state.viewportTop = sanitizeRow(metrics.viewportTop);
  }
  state.scrollTop = state.sticky
    ? clampScrollTop(state, maxScrollTop(state))
    : clampScrollTop(state, state.scrollTop);
  return snapshotSignature(state) !== previous;
}

export function applyClampBounds(state: ScrollDomState, clamp: ScrollClampBounds): boolean {
  const previous = snapshotSignature(state);
  state.clamp = { ...clamp };
  state.scrollTop = clampScrollTop(state, state.sticky ? maxScrollTop(state) : state.scrollTop);
  return snapshotSignature(state) !== previous;
}

export function drainPendingScrollDelta(state: ScrollDomState, maxStep = Number.POSITIVE_INFINITY): boolean {
  const pending = sanitizeRow(state.pendingDelta);
  if (pending === 0) {
    return false;
  }
  const stepLimit = Math.max(1, Math.floor(Math.abs(maxStep)));
  const step = Math.sign(pending) * Math.min(Math.abs(pending), stepLimit);
  const previousTop = state.scrollTop;
  const nextTop = clampScrollTop(state, previousTop + step);
  const consumed = nextTop - previousTop;
  state.scrollTop = nextTop;
  state.pendingDelta = Math.abs(consumed) < Math.abs(step)
    ? 0
    : pending - consumed;
  return true;
}

export function scrollWindow(snapshot: ScrollDomSnapshot, overscan = 0): ScrollWindow {
  const viewportHeight = Math.max(0, sanitizeRow(snapshot.viewportHeight));
  const scrollHeight = Math.max(0, sanitizeRow(snapshot.scrollHeight));
  const committedTop = clampScrollTop(snapshot, snapshot.scrollTop);
  const pendingTop = clampScrollTop(snapshot, snapshot.scrollTop + snapshot.pendingDelta);
  const overscanRows = Math.max(0, sanitizeRow(overscan));
  const start = Math.max(0, Math.min(committedTop, pendingTop) - overscanRows);
  const end = Math.min(scrollHeight, Math.max(committedTop, pendingTop) + viewportHeight + overscanRows);
  const visibleBottom = Math.min(scrollHeight, committedTop + viewportHeight);
  return {
    start,
    end,
    committedStart: committedTop,
    committedEnd: Math.min(scrollHeight, committedTop + viewportHeight),
    pendingStart: pendingTop,
    pendingEnd: Math.min(scrollHeight, pendingTop + viewportHeight),
    hiddenAbove: committedTop,
    hiddenBelow: Math.max(0, scrollHeight - visibleBottom),
    atTop: committedTop <= 0,
    atBottom: visibleBottom >= scrollHeight
  };
}

function snapshotSignature(state: ScrollDomState): string {
  return [
    state.scrollTop,
    state.pendingDelta,
    state.scrollHeight,
    state.viewportHeight,
    state.viewportTop,
    state.sticky ? 1 : 0,
    state.clamp.min ?? "",
    state.clamp.max ?? ""
  ].join(":");
}
