import { strict as assert } from "node:assert";
import test from "node:test";
import { createInitialTuiAppState } from "./TuiAppState.js";
import { describeTuiAppStateChange } from "./onChangeTuiAppState.js";
import { createTuiStore } from "./store.js";

test("TUI store selector subscribers only fire when selected state changes", () => {
  const store = createTuiStore(createInitialTuiAppState());
  const focusTransitions: string[] = [];
  const transcriptCounts: number[] = [];

  store.subscribeSelector(
    (state) => state.product.focus.owner,
    (next, previous) => focusTransitions.push(`${previous}->${next}`)
  );
  store.subscribeSelector(
    (state) => state.product.transcript.messageCount,
    (next) => transcriptCounts.push(next)
  );

  store.setState((state) => ({
    ...state,
    renderer: {
      ...state.renderer,
      columns: 120
    }
  }));
  assert.deepEqual(focusTransitions, []);
  assert.deepEqual(transcriptCounts, []);

  store.setState((state) => ({
    ...state,
    product: {
      ...state.product,
      focus: {
        ...state.product.focus,
        owner: "detail",
        detailOpen: true
      }
    }
  }));
  assert.deepEqual(focusTransitions, ["input->detail"]);
  assert.deepEqual(transcriptCounts, []);

  store.setState((state) => ({
    ...state,
    product: {
      ...state.product,
      transcript: {
        ...state.product.transcript,
        messageCount: 2
      }
    }
  }));
  assert.deepEqual(transcriptCounts, [2]);
});

test("TUI app state change summary separates renderer and product changes", () => {
  const previous = createInitialTuiAppState();
  const next = {
    ...previous,
    renderer: {
      ...previous.renderer,
      rows: 40
    }
  };
  assert.deepEqual(describeTuiAppStateChange(next, previous), {
    rendererChanged: true,
    productChanged: false,
    focusChanged: false,
    transcriptChanged: false
  });
});

