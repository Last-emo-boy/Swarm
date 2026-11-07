import { strict as assert } from "node:assert";
import test from "node:test";
import type { RendererKey } from "./hooks/use-input.js";
import { ESC_KEY_DELAY_MS, TuiTerminalInputController } from "./terminal-input.js";

test("terminal input controller delivers keys and paste while consuming query responses", () => {
  const delivered: Array<{ input?: string; key: RendererKey }> = [];
  const mouse: unknown[] = [];
  const controller = new TuiTerminalInputController({
    dispatchInput(input, key = {}) {
      delivered.push({ input, key });
    },
    dispatchMouse(event) {
      mouse.push(event);
    }
  });

  const summary = controller.feed("a\u001B[200~paste\nbody\u001B[201~\u001B[<0;4;2M\u001B[?1;2c");

  assert.deepEqual(delivered, [
    { input: "a", key: {} },
    { input: "paste\nbody", key: { paste: true } }
  ]);
  assert.deepEqual(mouse, [{ x: 3, y: 1, button: "left", action: "press" }]);
  assert.deepEqual(summary, {
    delivered: 2,
    responses: 1,
    mouse: 1,
    focus: 0,
    malformed: 0
  });
  assert.equal(controller.querier.history().length, 1);
});

test("a lone Esc counts as the Esc key once no sequence follows, and an arrow sent in one write stays an arrow", async () => {
  const delivered: Array<{ input?: string; key: RendererKey }> = [];
  const controller = new TuiTerminalInputController({
    dispatchInput(input, key = {}) {
      delivered.push({ input, key });
    }
  });

  controller.feed("\u001B");
  assert.equal(delivered.length, 0, "Esc waits briefly for the rest of a sequence");
  await new Promise((resolve) => setTimeout(resolve, ESC_KEY_DELAY_MS + 30));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.key.escape, true);

  delivered.length = 0;
  controller.feed("\u001B[A");
  await new Promise((resolve) => setTimeout(resolve, ESC_KEY_DELAY_MS + 30));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.key.upArrow, true);

  delivered.length = 0;
  controller.feed("\u001B");
  controller.feed("[A");
  assert.equal(delivered.length, 1, "a sequence split across writes still parses when its rest comes in time");
  assert.equal(delivered[0]?.key.upArrow, true);
});
