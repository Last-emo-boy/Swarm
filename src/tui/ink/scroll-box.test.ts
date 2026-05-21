import { strict as assert } from "node:assert";
import test from "node:test";
import { createScrollBoxController } from "./ScrollBox.js";

test("scrollTo clamps committed position and breaks sticky mode", () => {
  const scroll = createScrollBoxController({
    scrollHeight: 120,
    viewportHeight: 20,
    stickyScroll: true
  });

  scroll.scrollToBottom();
  assert.equal(scroll.getScrollTop(), 100);
  assert.equal(scroll.isSticky(), true);

  scroll.scrollTo(200);
  assert.equal(scroll.getScrollTop(), 100);
  assert.equal(scroll.getPendingDelta(), 0);
  assert.equal(scroll.isSticky(), false);

  scroll.scrollTo(-10);
  assert.equal(scroll.getScrollTop(), 0);
});

test("scrollBy accumulates pending deltas without committing every input event", () => {
  const scroll = createScrollBoxController({ scrollHeight: 80, viewportHeight: 20 });

  scroll.scrollTo(10);
  scroll.scrollBy(6);
  scroll.scrollBy(4);

  assert.equal(scroll.getScrollTop(), 10);
  assert.equal(scroll.getPendingDelta(), 10);
  assert.equal(scroll.isSticky(), false);

  scroll.drainPendingDelta(4);
  assert.equal(scroll.getScrollTop(), 14);
  assert.equal(scroll.getPendingDelta(), 6);

  scroll.drainPendingDelta();
  assert.equal(scroll.getScrollTop(), 20);
  assert.equal(scroll.getPendingDelta(), 0);
});

test("sticky bottom follows content growth until manual scroll breaks stickiness", () => {
  const scroll = createScrollBoxController({
    scrollHeight: 40,
    viewportHeight: 10,
    stickyScroll: true
  });

  scroll.scrollToBottom();
  assert.equal(scroll.getScrollTop(), 30);

  scroll.setMetrics({ scrollHeight: 70 });
  assert.equal(scroll.getScrollTop(), 60);
  assert.equal(scroll.isSticky(), true);

  scroll.scrollTo(20);
  scroll.setMetrics({ scrollHeight: 100 });
  assert.equal(scroll.getScrollTop(), 20);
  assert.equal(scroll.isSticky(), false);
});

test("clamp bounds constrain scrollTo, pending drain, and bottom pinning", () => {
  const scroll = createScrollBoxController({ scrollHeight: 200, viewportHeight: 20 });

  scroll.setClampBounds(30, 90);
  scroll.scrollTo(10);
  assert.equal(scroll.getScrollTop(), 30);

  scroll.scrollTo(100);
  assert.equal(scroll.getScrollTop(), 90);

  scroll.scrollBy(-100);
  scroll.drainPendingDelta();
  assert.equal(scroll.getScrollTop(), 30);
  assert.equal(scroll.getPendingDelta(), 0);

  scroll.scrollToBottom();
  assert.equal(scroll.getScrollTop(), 90);
  assert.equal(scroll.isSticky(), true);
});

test("subscribe reports imperative scroll mutations and supports unsubscribe", () => {
  const scroll = createScrollBoxController({ scrollHeight: 100, viewportHeight: 20 });
  let calls = 0;
  const unsubscribe = scroll.subscribe(() => {
    calls += 1;
  });

  scroll.scrollTo(5);
  scroll.scrollBy(3);
  assert.equal(calls, 2);

  unsubscribe();
  scroll.scrollToBottom();
  assert.equal(calls, 2);
});

test("scroll window includes pending range so virtual rows do not blank during drain", () => {
  const scroll = createScrollBoxController({ scrollHeight: 100, viewportHeight: 10 });

  scroll.scrollTo(20);
  scroll.scrollBy(25);

  assert.deepEqual(scroll.getWindow(2), {
    start: 18,
    end: 57,
    committedStart: 20,
    committedEnd: 30,
    pendingStart: 45,
    pendingEnd: 55,
    hiddenAbove: 20,
    hiddenBelow: 70,
    atTop: false,
    atBottom: false
  });
});

