import React from "react";
import { createTuiRoot } from "./root.js";
import type { TuiFrame } from "./frame.js";
import { screenToLines, screenToString } from "./screen.js";
import type { TuiRendererMode } from "../ui.js";
import { withTuiRendererMode } from "../ui.js";

export function renderTuiToFrame(
  node: React.ReactNode,
  options: { columns?: number; rows?: number; mode?: TuiRendererMode } = {}
): TuiFrame {
  return withTuiRendererMode(options.mode ?? "dom-renderer", () => {
    const root = createTuiRoot({
      columns: options.columns ?? 80,
      rows: options.rows ?? 24
    });
    root.render(node);
    const frame = root.getFrame();
    root.unmount();
    if (!frame) {
      throw new Error("Renderer did not produce a frame.");
    }
    return frame;
  });
}

export function frameLines(frame: TuiFrame): string[] {
  return screenToLines(frame.screen);
}

export function frameText(frame: TuiFrame): string {
  return screenToString(frame.screen);
}

