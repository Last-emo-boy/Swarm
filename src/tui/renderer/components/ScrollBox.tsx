import React from "react";
import { Box, type RendererBoxProps } from "./Box.js";

export type RendererScrollBoxHandle = {
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

export type RendererScrollBoxProps = RendererBoxProps & {
  stickyScroll?: boolean;
  scrollTop?: number;
  scrollHeight?: number;
  viewportHeight?: number;
  viewportTop?: number;
};

export const ScrollBox = React.forwardRef<RendererScrollBoxHandle, RendererScrollBoxProps>(function ScrollBox(
  {
    children,
    stickyScroll,
    scrollTop,
    scrollHeight,
    viewportHeight,
    viewportTop,
    ...props
  },
  ref
) {
  const scrollTopValue = scrollTop ?? 0;
  const scrollHeightValue = scrollHeight ?? 0;
  const viewportHeightValue = viewportHeight ?? 0;
  const viewportTopValue = viewportTop ?? 0;
  React.useImperativeHandle(ref, () => ({
    scrollTo: () => undefined,
    scrollBy: () => undefined,
    scrollToBottom: () => undefined,
    getScrollTop: () => scrollTopValue,
    getPendingDelta: () => 0,
    getScrollHeight: () => scrollHeightValue,
    getFreshScrollHeight: () => scrollHeightValue,
    getViewportHeight: () => viewportHeightValue,
    getViewportTop: () => viewportTopValue,
    isSticky: () => Boolean(stickyScroll),
    subscribe: () => () => undefined,
    setClampBounds: () => undefined
  }), [scrollHeightValue, scrollTopValue, stickyScroll, viewportHeightValue, viewportTopValue]);

  return React.createElement(
    "swarm-scroll",
    {
      ...props,
      stickyScroll,
      scrollTop,
      scrollHeight,
      viewportHeight,
      viewportTop
    },
    React.createElement(Box, { flexDirection: "column", width: props.width }, children)
  );
});

export default ScrollBox;
