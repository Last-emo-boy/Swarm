/**
 * The subset of vitest's `expect` and `vi.fn` that the superagent specs use, on top of `node:assert`, so the specs ported
 * from dsh-superagent keep their assertions verbatim under `node:test`.
 * Semantics follow vitest: `toEqual` ignores undefined properties, `toMatchObject` matches a subset of each object and
 * the full length of each array, and `toThrow` with an Error compares messages.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { inspect } from "node:util";

const ASYMMETRIC = Symbol("asymmetric");
type Asymmetric = { [ASYMMETRIC]: true; matches(value: unknown): boolean; describe: string };

function asymmetric(describe: string, matches: (value: unknown) => boolean): Asymmetric {
  return { [ASYMMETRIC]: true, matches, describe };
}
function isAsymmetric(value: unknown): value is Asymmetric {
  return typeof value === "object" && value !== null && ASYMMETRIC in value;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Deep equality; `subset` compares only the keys of `expected` objects, as `toMatchObject` does. */
export function equals(actual: unknown, expected: unknown, subset = false): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (Object.is(actual, expected)) return true;
  if (!isPlainRecord(actual) || !isPlainRecord(expected)) return false;
  if (actual instanceof Date || expected instanceof Date) {
    return actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime();
  }
  if (actual instanceof Error && expected instanceof Error) return actual.message === expected.message;
  if (actual instanceof RegExp || expected instanceof RegExp) return String(actual) === String(expected);
  if (actual instanceof Map || expected instanceof Map) {
    if (!(actual instanceof Map) || !(expected instanceof Map) || actual.size !== expected.size) return false;
    return [...expected].every(([key, value]) => actual.has(key) && equals(actual.get(key), value, subset));
  }
  if (actual instanceof Set || expected instanceof Set) {
    if (!(actual instanceof Set) || !(expected instanceof Set) || actual.size !== expected.size) return false;
    return [...expected].every((value) => [...actual].some((item) => equals(item, value, subset)));
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    return expected.every((value, index) => equals(actual[index], value, subset));
  }
  const expectedKeys = Object.keys(expected).filter((key) => expected[key] !== undefined || subset);
  if (!subset) {
    const actualKeys = Object.keys(actual).filter((key) => actual[key] !== undefined);
    if (actualKeys.length !== expectedKeys.length) return false;
  }
  return expectedKeys.every((key) => {
    if (subset && !(key in actual)) return false;
    return equals(actual[key], expected[key], subset);
  });
}

function show(value: unknown): string {
  return inspect(value, { depth: 8, breakLength: 120 });
}

function readPath(value: unknown, path: string | readonly (string | number)[]): { found: boolean; value: unknown } {
  const parts = typeof path === "string" ? path.split(".").filter(Boolean) : path;
  let current: unknown = value;
  for (const part of parts) {
    if (!isPlainRecord(current) || !(String(part) in current)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[String(part)];
  }
  return { found: true, value: current };
}

export type Mock<Args extends unknown[] = any[], Result = any> = ((...args: Args) => Result) & {
  mock: { calls: Args[]; results: { type: "return" | "throw"; value: unknown }[]; readonly lastCall: Args | undefined };
  mockClear(): Mock<Args, Result>;
  mockReset(): Mock<Args, Result>;
  mockRestore(): void;
  mockImplementation(next: (...args: Args) => Result): Mock<Args, Result>;
  mockImplementationOnce(next: (...args: Args) => Result): Mock<Args, Result>;
  mockReturnValue(value: Result): Mock<Args, Result>;
  mockReturnValueOnce(value: Result): Mock<Args, Result>;
  mockResolvedValue(value: Awaited<Result>): Mock<Args, Result>;
  mockResolvedValueOnce(value: Awaited<Result>): Mock<Args, Result>;
  mockRejectedValue(error: unknown): Mock<Args, Result>;
  mockRejectedValueOnce(error: unknown): Mock<Args, Result>;
};

function isMock(value: unknown): value is Mock {
  return typeof value === "function" && "mock" in value;
}

function thrownBy(run: unknown): { threw: boolean; error: unknown } {
  assert.equal(typeof run, "function", "toThrow expects a function");
  try {
    (run as () => unknown)();
    return { threw: false, error: undefined };
  } catch (error) {
    return { threw: true, error };
  }
}

function throwMatches(error: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof expected === "string") return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (expected instanceof Error) return message === expected.message;
  if (typeof expected === "function") return error instanceof (expected as new (...args: unknown[]) => unknown);
  return equals(error, expected, true);
}

type Matchers = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toMatchObject(expected: unknown): void;
  toThrow(expected?: unknown): void;
  toHaveProperty(path: string | readonly (string | number)[], value?: unknown): void;
  toHaveLength(length: number): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(item: unknown): void;
  toContainEqual(item: unknown): void;
  toMatch(pattern: string | RegExp): void;
  toBeGreaterThan(value: number): void;
  toBeGreaterThanOrEqual(value: number): void;
  toBeLessThan(value: number): void;
  toBeLessThanOrEqual(value: number): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(times: number): void;
  toHaveBeenCalledWith(...args: unknown[]): void;
  toHaveBeenCalledOnce(): void;
  toHaveBeenCalledExactlyOnceWith(...args: unknown[]): void;
  toHaveBeenLastCalledWith(...args: unknown[]): void;
};

function matchers(actual: unknown, negated: boolean): Matchers {
  const check = (pass: boolean, message: () => string) => {
    if (pass === negated) assert.fail(`${negated ? "Expected not: " : ""}${message()}`);
  };
  const calls = () => {
    assert.ok(isMock(actual), "expected a mock function");
    return (actual as Mock).mock.calls;
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), () => `${show(actual)} to be ${show(expected)}`),
    toEqual: (expected) => check(equals(actual, expected), () => `${show(actual)}\nto equal\n${show(expected)}`),
    toStrictEqual: (expected) => check(equals(actual, expected), () => `${show(actual)}\nto strictly equal\n${show(expected)}`),
    toMatchObject: (expected) => check(equals(actual, expected, true), () => `${show(actual)}\nto match object\n${show(expected)}`),
    toThrow: (expected) => {
      const { threw, error } = thrownBy(actual);
      check(threw && throwMatches(error, expected), () => threw ? `thrown ${show(error)} to match ${show(expected)}` : "function to throw");
    },
    toHaveProperty: (path, ...value) => {
      const found = readPath(actual, path);
      const pass = found.found && (value.length === 0 || equals(found.value, value[0]));
      check(pass, () => `${show(actual)} to have property ${show(path)}${value.length ? ` = ${show(value[0])}` : ""}`);
    },
    toHaveLength: (length) => check((actual as { length?: number })?.length === length,
      () => `${show(actual)} to have length ${length}`),
    toBeUndefined: () => check(actual === undefined, () => `${show(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, () => "value to be defined"),
    toBeNull: () => check(actual === null, () => `${show(actual)} to be null`),
    toBeTruthy: () => check(Boolean(actual), () => `${show(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, () => `${show(actual)} to be falsy`),
    toContain: (item) => check(typeof actual === "string" ? actual.includes(String(item)) : Array.isArray(actual) && actual.includes(item),
      () => `${show(actual)} to contain ${show(item)}`),
    toContainEqual: (item) => check(Array.isArray(actual) && actual.some((value) => equals(value, item)),
      () => `${show(actual)} to contain equal ${show(item)}`),
    toMatch: (pattern) => check(typeof actual === "string" && (typeof pattern === "string" ? actual.includes(pattern) : pattern.test(actual)),
      () => `${show(actual)} to match ${show(pattern)}`),
    toBeGreaterThan: (value) => check(typeof actual === "number" && actual > value, () => `${show(actual)} > ${value}`),
    toBeGreaterThanOrEqual: (value) => check(typeof actual === "number" && actual >= value, () => `${show(actual)} >= ${value}`),
    toBeLessThan: (value) => check(typeof actual === "number" && actual < value, () => `${show(actual)} < ${value}`),
    toBeLessThanOrEqual: (value) => check(typeof actual === "number" && actual <= value, () => `${show(actual)} <= ${value}`),
    toHaveBeenCalled: () => check(calls().length > 0, () => "mock to have been called"),
    toHaveBeenCalledTimes: (times) => check(calls().length === times, () => `mock called ${calls().length} times, expected ${times}`),
    toHaveBeenCalledWith: (...args) => check(calls().some((call) => equals(call, args)),
      () => `mock calls ${show(calls())} to include ${show(args)}`),
    toHaveBeenCalledOnce: () => check(calls().length === 1, () => `mock called ${calls().length} times, expected once`),
    toHaveBeenCalledExactlyOnceWith: (...args) => check(calls().length === 1 && equals(calls()[0], args),
      () => `mock calls ${show(calls())} to be exactly one call with ${show(args)}`),
    toHaveBeenLastCalledWith: (...args) => check(calls().length > 0 && equals(calls().at(-1), args),
      () => `last mock call ${show(calls().at(-1))} to equal ${show(args)}`),
  };
}

type AsyncMatchers = { [K in keyof Matchers]: (...args: Parameters<Matchers[K]>) => Promise<void> };
type Expectation = Matchers & { not: Matchers; rejects: AsyncMatchers & { not: AsyncMatchers }; resolves: AsyncMatchers & { not: AsyncMatchers } };

/** `expect(promise).rejects` and `.resolves`: settle the promise, then match its error (a rejection) or value. */
function settled(actual: unknown, want: "rejects" | "resolves", negated: boolean): AsyncMatchers {
  const names = Object.keys(matchers(undefined, false)) as (keyof Matchers)[];
  return Object.fromEntries(names.map((name) => [name, async (...args: unknown[]) => {
    let value: unknown;
    let rejected = false;
    try { value = await actual; } catch (error) { value = error; rejected = true; }
    if (rejected !== (want === "rejects")) {
      assert.fail(want === "rejects" ? `Expected the promise to reject, it resolved ${show(value)}` : `Expected the promise to resolve, it rejected ${show(value)}`);
    }
    // A rejection's toThrow matches the error itself, so wrap it in a function that throws it again.
    const subject = name === "toThrow" ? () => { throw value; } : value;
    (matchers(subject, negated)[name] as (...values: unknown[]) => void)(...args);
  }])) as AsyncMatchers;
}

type Expect = ((actual: unknown) => Expectation) & {
  objectContaining(expected: Record<string, unknown>): any;
  arrayContaining(expected: readonly unknown[]): any;
  stringContaining(expected: string): any;
  stringMatching(expected: string | RegExp): any;
  any(constructor: unknown): any;
  anything(): any;
};

export const expect: Expect = Object.assign(
  (actual: unknown) => Object.assign(matchers(actual, false), {
    not: matchers(actual, true),
    rejects: Object.assign(settled(actual, "rejects", false), { not: settled(actual, "rejects", true) }),
    resolves: Object.assign(settled(actual, "resolves", false), { not: settled(actual, "resolves", true) })
  }),
  {
    objectContaining: (expected: Record<string, unknown>) => asymmetric(`objectContaining ${show(expected)}`,
      (value) => isPlainRecord(value) && equals(value, expected, true)),
    arrayContaining: (expected: readonly unknown[]) => asymmetric(`arrayContaining ${show(expected)}`,
      (value) => Array.isArray(value) && expected.every((item) => value.some((entry) => equals(entry, item)))),
    stringContaining: (expected: string) => asymmetric(`stringContaining ${show(expected)}`,
      (value) => typeof value === "string" && value.includes(expected)),
    stringMatching: (expected: string | RegExp) => asymmetric(`stringMatching ${show(expected)}`,
      (value) => typeof value === "string" && (typeof expected === "string" ? value.includes(expected) : expected.test(value))),
    any: (constructor: unknown) => asymmetric(`any ${String((constructor as { name?: string }).name)}`, (value) => {
      if (constructor === String) return typeof value === "string" || value instanceof String;
      if (constructor === Number) return typeof value === "number" || value instanceof Number;
      if (constructor === Boolean) return typeof value === "boolean" || value instanceof Boolean;
      if (constructor === Function) return typeof value === "function";
      if (constructor === Object) return typeof value === "object" && value !== null;
      return value instanceof (constructor as new (...args: unknown[]) => unknown);
    }),
    anything: () => asymmetric("anything", (value) => value !== undefined && value !== null),
  },
);

const spies = new Set<() => void>();

function fn<Args extends unknown[] = any[], Result = any>(implementation?: (...args: Args) => Result): Mock<Args, Result> {
  let current = implementation;
  const once: ((...args: Args) => Result)[] = [];
  const mock = ((...args: Args) => {
    mock.mock.calls.push(args);
    try {
      const next = once.shift() ?? current;
      const value = next?.(...args) as Result;
      mock.mock.results.push({ type: "return", value });
      return value;
    } catch (error) {
      mock.mock.results.push({ type: "throw", value: error });
      throw error;
    }
  }) as Mock<Args, Result>;
  mock.mock = { calls: [], results: [], get lastCall() { return this.calls.at(-1); } };
  mock.mockClear = () => { mock.mock.calls = []; mock.mock.results = []; return mock; };
  mock.mockReset = () => { mock.mockClear(); once.length = 0; current = undefined; return mock; };
  mock.mockRestore = () => { mock.mockReset(); };
  mock.mockImplementation = (next) => { current = next; return mock; };
  mock.mockImplementationOnce = (next) => { once.push(next); return mock; };
  mock.mockReturnValue = (value) => mock.mockImplementation(() => value);
  mock.mockReturnValueOnce = (value) => mock.mockImplementationOnce(() => value);
  mock.mockResolvedValue = (value) => mock.mockImplementation(() => Promise.resolve(value) as Result);
  mock.mockResolvedValueOnce = (value) => mock.mockImplementationOnce(() => Promise.resolve(value) as Result);
  mock.mockRejectedValue = (error) => mock.mockImplementation(() => Promise.reject(error) as Result);
  mock.mockRejectedValueOnce = (error) => mock.mockImplementationOnce(() => Promise.reject(error) as Result);
  return mock;
}

/** Replace `object[name]` with a mock that calls the original until given another implementation; `mockRestore` puts it back. */
function spyOn<T extends object, K extends keyof T>(object: T, name: K): Mock {
  const original = object[name] as unknown as (...args: unknown[]) => unknown;
  const spy = fn((...args: unknown[]) => original.apply(object, args));
  const restore = () => { object[name] = original as T[K]; spies.delete(restore); };
  const reset = spy.mockReset;
  spy.mockRestore = () => { reset(); restore(); };
  object[name] = spy as T[K];
  spies.add(restore);
  return spy;
}

/** Retry `check` until it stops throwing or `timeout` passes, then return its value or throw its last error. */
async function waitFor<T>(check: () => T | Promise<T>, options: number | { timeout?: number; interval?: number } = {}): Promise<T> {
  const { timeout = 1000, interval = 20 } = typeof options === "number" ? { timeout: options } : options;
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

export const vi = {
  fn,
  spyOn,
  waitFor,
  mocked: <T>(value: T): T & Mock => value as T & Mock,
  restoreAllMocks: (): void => { for (const restore of [...spies]) restore(); },
};

/**
 * vitest's `it.each(rows)(name, fn)`: one test per row. An array row is spread into `fn`, with `%s` in the name replaced by
 * its values in order; an object row is passed whole, with `$key` in the name replaced by its values.
 */
export function each(rows: readonly unknown[]) {
  return (name: string, run: (...args: any[]) => unknown): void => {
    for (const row of rows) {
      const values = Array.isArray(row) ? row : [row];
      let index = 0;
      const title = name.replace(/%[sdj]/g, () => String(values[index++]))
        .replace(/\$([A-Za-z_]\w*)/g, (match, key: string) => isPlainRecord(row) && key in row ? String((row as Record<string, unknown>)[key]) : match);
      it(title, async () => { await run(...values); });
    }
  };
}
