import React, { useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Box } from "../ui.js";
import type { RendererBoxProps as BoxProps } from "../renderer/components/Box.js";
import {
  clampScrollTop,
  createScrollDomState,
  maxScrollTop,
  sanitizeRow,
  scrollSnapshot,
  type ScrollDomSnapshot,
  type ScrollDomState
} from "./dom.js";
import {
  applyClampBounds,
  applyScrollMetrics,
  drainPendingScrollDelta,
  scrollWindow,
  type ScrollMetrics,
  type ScrollWindow
} from "./rendering.js";

export type ScrollBoxHandle = {
  scrollTo: (y: number) => void;
  scrollBy: (dy: number) => void;
  scrollToBottom: () => void;
  getScrollTop: () => number;
  getPendingDelta: () => number;
  getScrollHeight: () => number;
  getFreshScrollHeight: () => number;
  getViewportHeight: () => number;
  getViewportTop: () => number;
  isSticky: () => boolean;
  subscribe: (listener: () => void) => () => void;
  setClampBounds: (min: number | undefined, max: number | undefined) => void;
};

export type ScrollBoxController = ScrollBoxHandle & {
  setMetrics: (metrics: ScrollMetrics) => void;
  drainPendingDelta: (maxStep?: number) => void;
  getSnapshot: () => ScrollDomSnapshot;
  getWindow: (overscan?: number) => ScrollWindow;
};

export type ScrollBoxProps = Omit<BoxProps, "overflow" | "overflowX" | "overflowY"> & {
  children?: React.ReactNode;
  stickyScroll?: boolean;
  scrollHeight?: number;
  viewportHeight?: number;
  viewportTop?: number;
  onScrollChange?: (snapshot: ScrollDomSnapshot) => void;
};

export function createScrollBoxController(input: {
  scrollHeight?: number;
  viewportHeight?: number;
  viewportTop?: number;
  stickyScroll?: boolean;
  scrollTop?: number;
} = {}): ScrollBoxController {
  const state = createScrollDomState({
    scrollTop: input.scrollTop,
    scrollHeight: input.scrollHeight,
    viewportHeight: input.viewportHeight,
    viewportTop: input.viewportTop,
    sticky: Boolean(input.stickyScroll)
  });
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function mutate(mutator: (state: ScrollDomState) => boolean | void): void {
    const changed = mutator(state) !== false;
    if (changed) {
      notify();
    }
  }

  return {
    scrollTo(y: number) {
      mutate((current) => {
        current.sticky = false;
        current.pendingDelta = 0;
        current.scrollTop = clampScrollTop(current, y);
      });
    },
    scrollBy(dy: number) {
      const delta = sanitizeRow(dy);
      if (delta === 0) {
        return;
      }
      mutate((current) => {
        current.sticky = false;
        current.pendingDelta += delta;
      });
    },
    scrollToBottom() {
      mutate((current) => {
        current.pendingDelta = 0;
        current.sticky = true;
        current.scrollTop = clampScrollTop(current, maxScrollTop(current));
      });
    },
    getScrollTop() {
      return state.scrollTop;
    },
    getPendingDelta() {
      return state.pendingDelta;
    },
    getScrollHeight() {
      return state.scrollHeight;
    },
    getFreshScrollHeight() {
      return state.scrollHeight;
    },
    getViewportHeight() {
      return state.viewportHeight;
    },
    getViewportTop() {
      return state.viewportTop;
    },
    isSticky() {
      return state.sticky;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setClampBounds(min: number | undefined, max: number | undefined) {
      mutate((current) => applyClampBounds(current, { min, max }));
    },
    setMetrics(metrics: ScrollMetrics) {
      mutate((current) => applyScrollMetrics(current, metrics));
    },
    drainPendingDelta(maxStep?: number) {
      mutate((current) => drainPendingScrollDelta(current, maxStep));
    },
    getSnapshot() {
      return scrollSnapshot(state);
    },
    getWindow(overscan?: number) {
      return scrollWindow(scrollSnapshot(state), overscan);
    }
  };
}

export const ScrollBox = React.forwardRef<ScrollBoxHandle, ScrollBoxProps>(function ScrollBox(
  {
    children,
    stickyScroll = false,
    scrollHeight,
    viewportHeight,
    viewportTop,
    onScrollChange,
    flexDirection = "column",
    flexGrow = 0,
    flexShrink = 1,
    ...style
  },
  ref
) {
  const controllerRef = useRef<ScrollBoxController>();
  controllerRef.current ??= createScrollBoxController({ stickyScroll });
  const controller = controllerRef.current;
  const metrics = useMemo(
    () => ({
      scrollHeight,
      viewportHeight: viewportHeight ?? numericHeight(style.height),
      viewportTop
    }),
    [scrollHeight, style.height, viewportHeight, viewportTop]
  );

  useEffect(() => {
    controller.setMetrics(metrics);
  }, [controller, metrics]);

  useEffect(() => {
    if (!onScrollChange) {
      return undefined;
    }
    onScrollChange(controller.getSnapshot());
    return controller.subscribe(() => onScrollChange(controller.getSnapshot()));
  }, [controller, onScrollChange]);

  useImperativeHandle(ref, () => controller, [controller]);

  return (
    <Box
      {...style}
      flexDirection={flexDirection}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      overflow="hidden"
    >
      <Box flexDirection="column" flexGrow={1} flexShrink={0} width="100%">
        {children}
      </Box>
    </Box>
  );
});

export default ScrollBox;

function numericHeight(value: BoxProps["height"]): number | undefined {
  return typeof value === "number" ? value : undefined;
}
