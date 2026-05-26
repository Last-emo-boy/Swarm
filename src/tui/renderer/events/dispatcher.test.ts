import { strict as assert } from "node:assert";
import test from "node:test";
import { appendChild, createElement } from "../dom.js";
import { TuiFocusManager } from "../focus.js";
import { TuiDomEventDispatcher, TuiInputDispatcher } from "./dispatcher.js";
import { tuiInputEventLabel } from "./input-event.js";
import { TuiTerminalEvent } from "./terminal-event.js";

test("input dispatcher routes active overlays before chat input", () => {
  const events: string[] = [];
  const dispatcher = new TuiInputDispatcher();
  dispatcher.register({
    id: "chat-input",
    priority: 0,
    handle(event) {
      events.push(`chat:${tuiInputEventLabel(event)}`);
      return true;
    }
  });
  const unregisterApproval = dispatcher.register({
    id: "approval-modal",
    priority: 100,
    handle(event) {
      events.push(`approval:${tuiInputEventLabel(event)}`);
      return event.key.return === true;
    }
  });

  assert.deepEqual(dispatcher.routeIds(), ["approval-modal", "chat-input"]);
  assert.equal(dispatcher.dispatch(undefined, { return: true }, "approval").handlerId, "approval-modal");
  assert.equal(dispatcher.dispatch("x", {}, "approval").handlerId, "chat-input");
  unregisterApproval();
  assert.equal(dispatcher.dispatch("x", {}, "input").handlerId, "chat-input");
  assert.deepEqual(events, ["approval:return", "approval:x", "chat:x", "chat:x"]);
});

test("dom event dispatcher runs capture target and bubble handlers in order", () => {
  const root = createElement("swarm-root");
  const parent = createElement("swarm-box");
  const child = createElement("swarm-box");
  appendChild(root, parent);
  appendChild(parent, child);
  const calls: string[] = [];
  root.eventHandlers.onKeydownCapture = (event: TuiTerminalEvent) => calls.push(`root:${event.eventPhase}`);
  parent.eventHandlers.onKeydownCapture = (event: TuiTerminalEvent) => calls.push(`parent:${event.eventPhase}`);
  child.eventHandlers.onKeydown = (event: TuiTerminalEvent) => calls.push(`child:${event.eventPhase}`);
  parent.eventHandlers.onKeydown = (event: TuiTerminalEvent) => calls.push(`parent:${event.eventPhase}`);

  const dispatcher = new TuiDomEventDispatcher();
  assert.equal(dispatcher.dispatch(child, new TuiTerminalEvent("keydown")), true);
  assert.deepEqual(calls, ["root:capturing", "parent:capturing", "child:at_target", "parent:bubbling"]);
});

test("dom event dispatcher honors preventDefault and propagation stop", () => {
  const root = createElement("swarm-root");
  const child = createElement("swarm-box");
  appendChild(root, child);
  const calls: string[] = [];
  child.eventHandlers.onKeydown = (event: TuiTerminalEvent) => {
    calls.push("child");
    event.preventDefault();
    event.stopPropagation();
  };
  root.eventHandlers.onKeydown = () => calls.push("root");

  const dispatcher = new TuiDomEventDispatcher();
  assert.equal(dispatcher.dispatch(child, new TuiTerminalEvent("keydown")), false);
  assert.deepEqual(calls, ["child"]);
});

test("focus manager restores focus when active node is removed", () => {
  const root = createElement("swarm-root");
  const prompt = createElement("swarm-box", { focusable: true });
  const modal = createElement("swarm-box", { focusable: true });
  appendChild(root, prompt);
  appendChild(root, modal);
  const events: string[] = [];
  const dispatcher = new TuiDomEventDispatcher();
  prompt.eventHandlers.onFocus = () => events.push("prompt:focus");
  prompt.eventHandlers.onBlur = () => events.push("prompt:blur");
  modal.eventHandlers.onFocus = () => events.push("modal:focus");
  modal.eventHandlers.onBlur = () => events.push("modal:blur");
  const focus = new TuiFocusManager((target, event) => dispatcher.dispatch(target, event));

  focus.focus(prompt);
  focus.focus(modal);
  root.childNodes.splice(root.childNodes.indexOf(modal), 1);
  modal.parentNode = undefined;
  focus.handleNodeRemoved(modal, root);

  assert.equal(focus.activeElement, prompt);
  assert.equal(prompt.focused, true);
  assert.deepEqual(events, ["prompt:focus", "prompt:blur", "modal:focus", "modal:blur", "prompt:focus"]);
});
