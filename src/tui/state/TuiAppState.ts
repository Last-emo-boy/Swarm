import type { TuiDensity, TuiFocusOwner } from "../conversation-layout.js";

export type TuiRendererOwnedState = {
  mode: "dom-renderer";
  columns: number;
  rows: number;
  frame: {
    lastRenderMs?: number;
    dirtyNodeCount?: number;
    nodeCount?: number;
  };
};

export type TuiProductOwnedState = {
  focus: {
    owner: TuiFocusOwner;
    previousOwner?: TuiFocusOwner;
    detailOpen: boolean;
    detailSource: "none" | "ai" | "command" | "task" | "event";
  };
  transcript: {
    messageCount: number;
    mountedMessageCount: number;
    unseenCount: number;
  };
  scroll: {
    top: number;
    height: number;
    viewportHeight: number;
    sticky: boolean;
  };
  search: {
    active: boolean;
    query: string;
    matchCount: number;
    currentIndex?: number;
  };
  folding: {
    foldedMessageCount: number;
  };
  footer: {
    selectedId?: string;
  };
  status: {
    density: TuiDensity;
    cache?: string;
    gateway?: string;
    symphony?: string;
    swarm?: string;
    lsp?: string;
  };
};

export type TuiAppState = {
  renderer: TuiRendererOwnedState;
  product: TuiProductOwnedState;
};

export function createInitialTuiAppState(input: Partial<TuiAppState> = {}): TuiAppState {
  return {
    renderer: {
      mode: input.renderer?.mode ?? "dom-renderer",
      columns: input.renderer?.columns ?? 80,
      rows: input.renderer?.rows ?? 24,
      frame: { ...input.renderer?.frame }
    },
    product: {
      focus: {
        owner: input.product?.focus.owner ?? "input",
        previousOwner: input.product?.focus.previousOwner,
        detailOpen: input.product?.focus.detailOpen ?? false,
        detailSource: input.product?.focus.detailSource ?? "none"
      },
      transcript: {
        messageCount: input.product?.transcript.messageCount ?? 0,
        mountedMessageCount: input.product?.transcript.mountedMessageCount ?? 0,
        unseenCount: input.product?.transcript.unseenCount ?? 0
      },
      scroll: {
        top: input.product?.scroll.top ?? 0,
        height: input.product?.scroll.height ?? 0,
        viewportHeight: input.product?.scroll.viewportHeight ?? 0,
        sticky: input.product?.scroll.sticky ?? true
      },
      search: {
        active: input.product?.search.active ?? false,
        query: input.product?.search.query ?? "",
        matchCount: input.product?.search.matchCount ?? 0,
        currentIndex: input.product?.search.currentIndex
      },
      folding: {
        foldedMessageCount: input.product?.folding.foldedMessageCount ?? 0
      },
      footer: {
        selectedId: input.product?.footer.selectedId
      },
      status: {
        density: input.product?.status.density ?? "default",
        cache: input.product?.status.cache,
        gateway: input.product?.status.gateway,
        symphony: input.product?.status.symphony,
        swarm: input.product?.status.swarm,
        lsp: input.product?.status.lsp
      }
    }
  };
}
