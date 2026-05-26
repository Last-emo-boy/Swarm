import React from "react";
import { renderReactTreeToDom } from "./reconciler.js";
import { renderDomToFrame } from "./renderer.js";
import type { TuiFrame } from "./frame.js";

export type OffscreenRenderCacheKey = {
  id: string;
  width: number;
  height: number;
  revision?: string | number;
};

export type OffscreenRenderDiagnostics = {
  status: "cache_hit" | "cache_miss";
  cacheKey: string;
  renderMs: number;
  nodeCount: number;
};

export type OffscreenRenderResult = {
  frame: TuiFrame;
  diagnostics: OffscreenRenderDiagnostics;
};

export class OffscreenRenderCache {
  private readonly frames = new Map<string, TuiFrame>();

  render(node: React.ReactNode, key: OffscreenRenderCacheKey): OffscreenRenderResult {
    const cacheKey = offscreenCacheKey(key);
    const cached = this.frames.get(cacheKey);
    if (cached) {
      return {
        frame: cached,
        diagnostics: {
          status: "cache_hit",
          cacheKey,
          renderMs: 0,
          nodeCount: cached.metadata.nodeCount
        }
      };
    }
    const started = performance.now();
    const dom = renderReactTreeToDom(node, { ownerChain: ["OffscreenRender"] });
    const frame = renderDomToFrame(dom, { columns: key.width, rows: key.height });
    this.frames.set(cacheKey, frame);
    return {
      frame,
      diagnostics: {
        status: "cache_miss",
        cacheKey,
        renderMs: performance.now() - started,
        nodeCount: frame.metadata.nodeCount
      }
    };
  }

  clear(): void {
    this.frames.clear();
  }

  size(): number {
    return this.frames.size;
  }
}

export function renderToScreen(
  node: React.ReactNode,
  options: { width: number; height: number }
): OffscreenRenderResult {
  return new OffscreenRenderCache().render(node, {
    id: "single",
    width: options.width,
    height: options.height
  });
}

function offscreenCacheKey(key: OffscreenRenderCacheKey): string {
  return [key.id, key.width, key.height, key.revision ?? ""].join(":");
}

