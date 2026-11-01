import assert from "node:assert/strict";
import { test } from "node:test";
import { equals, expect, vi } from "./expect.js";

test("toEqual ignores undefined properties but not missing or different values", () => {
  expect({ a: 1, b: undefined }).toEqual({ a: 1 });
  assert.throws(() => expect({ a: 1 }).toEqual({ a: 2 }));
  assert.throws(() => expect({ a: 1, b: 2 }).toEqual({ a: 1 }));
  assert.throws(() => expect([1, 2]).toEqual([1]));
});

test("toMatchObject matches a subset of objects and the full length of arrays", () => {
  expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
  expect([{ a: 1, b: 2 }]).toMatchObject([{ a: 1 }]);
  assert.throws(() => expect([{ a: 1 }, { a: 2 }]).toMatchObject([{ a: 1 }]));
  assert.throws(() => expect({}).toMatchObject({ a: undefined }));
  assert.throws(() => expect({ a: { c: 1 } }).toMatchObject({ a: { c: 2 } }));
});

test("asymmetric matchers apply inside expected values", () => {
  expect({ id: "x", at: 3 }).toEqual({ id: expect.any(String), at: expect.anything() });
  expect({ list: [1, 2, 3] }).toEqual({ list: expect.arrayContaining([3, 1]) });
  expect({ text: "hello world" }).toEqual(expect.objectContaining({ text: expect.stringContaining("world") }));
  assert.throws(() => expect({ id: 3 }).toEqual({ id: expect.any(String) }));
  assert.equal(equals(null, expect.anything()), false);
});

test("toThrow compares Error messages, substrings and absence of a throw", () => {
  expect(() => { throw new Error("boom: detail"); }).toThrow("boom");
  expect(() => { throw new Error("exact"); }).toThrow(new Error("exact"));
  assert.throws(() => expect(() => { throw new Error("other"); }).toThrow(new Error("exact")));
  assert.throws(() => expect(() => undefined).toThrow());
  expect(() => undefined).not.toThrow();
});

test("not inverts and mocks record calls", () => {
  expect(1).not.toBe(2);
  assert.throws(() => expect(1).not.toBe(1));
  const spy = vi.fn((value: number) => value * 2);
  assert.equal(spy(2), 4);
  expect(spy).toHaveBeenCalledOnce();
  expect(spy).toHaveBeenCalledExactlyOnceWith(2);
  spy.mockClear();
  expect(spy).not.toHaveBeenCalled();
  expect({ a: { b: [1] } }).toHaveProperty("a.b", [1]);
  assert.throws(() => expect({ a: {} }).toHaveProperty("a.b"));
});
