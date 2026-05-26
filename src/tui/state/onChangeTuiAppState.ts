import type { TuiAppState } from "./TuiAppState.js";

export type TuiAppStateChange = {
  rendererChanged: boolean;
  productChanged: boolean;
  focusChanged: boolean;
  transcriptChanged: boolean;
};

export function describeTuiAppStateChange(next: TuiAppState, previous: TuiAppState): TuiAppStateChange {
  return {
    rendererChanged: next.renderer !== previous.renderer,
    productChanged: next.product !== previous.product,
    focusChanged: next.product.focus !== previous.product.focus,
    transcriptChanged: next.product.transcript !== previous.product.transcript
  };
}

