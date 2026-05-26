import { strict as assert } from "node:assert";
import test from "node:test";
import type { RendererKey } from "./hooks/use-input.js";
import { TuiTerminalInputController } from "./terminal-input.js";

test("terminal input controller delivers keys and paste while consuming query responses", () => {
  const delivered: Array<{ input?: string; key: RendererKey }> = [];
  const controller = new TuiTerminalInputController({
    dispatchInput(input, key = {}) {
      delivered.push({ input, key });
    }
  });

  const summary = controller.feed("a\u001B[200~paste\nbody\u001B[201~\u001B[?1;2c");

  assert.deepEqual(delivered, [
    { input: "a", key: {} },
    { input: "paste\nbody", key: { paste: true } }
  ]);
  assert.deepEqual(summary, {
    delivered: 2,
    responses: 1,
    mouse: 0,
    focus: 0,
    malformed: 0
  });
  assert.equal(controller.querier.history().length, 1);
});

