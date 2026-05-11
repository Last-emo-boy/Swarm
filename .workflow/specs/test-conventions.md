---
title: "Test Conventions"
category: test
---
# Test Conventions

Auto-generated from project analysis. Update manually as patterns evolve.

## Framework
- Framework: Node.js built-in test runner (`node:test`)
- Assertions: `node:assert` with strict mode (`import { strict as assert } from "node:assert"`)
- Run command: `node --import tsx --test "src/**/*.test.ts"`

## Directory Structure
- Pattern: co-located tests (test files in same directory as source)
- No separate `__tests__/` or `tests/` directories

## Naming Conventions
- Test files: `*.test.ts`
- Test cases: descriptive prose strings (`test("description", () => {})`)
- Helper factories: module-scope functions for test data creation

## Patterns
- Tests are self-contained (setup/teardown inline)
- No `beforeEach`/`afterEach` hooks observed
- Uses `assert.equal()`, `assert.deepEqual()`, `assert.doesNotThrow()`, `assert.throws()`
- Common test pattern: create test data with factory functions, exercise SUT, assert expected outcomes

## Entries
