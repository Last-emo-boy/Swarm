---
title: "Coding Conventions"
category: coding
---
# Coding Conventions

Auto-generated from project analysis. Update manually as patterns evolve.

## Formatting
- Indentation: 2 spaces (no tabs)
- Line length: not configured
- Semicolons: always
- Trailing commas: multi-line lists, except last item
- String quotes: double quotes for import paths, single quotes for display text

## Naming
- Variables/functions: camelCase
- Classes/types/interfaces: PascalCase
- Constants (module-level): UPPER_SNAKE_CASE
- Private class members: camelCase with `private readonly` keyword
- Type guards: camelCase with `is` prefix (e.g., `isRecord`, `isHttpUrl`)
- Files (.ts): kebab-case
- Files (.tsx): PascalCase
- Test files: `*.test.ts`, co-located with source

## Imports
- Style: named imports (one default import: `openai` SDK)
- Type-only imports: `import type { ... }` for types; `import { type X }` inline
- Path style: always relative (`./`, `../`), no path aliases
- File extension: always `.js` (NodeNext resolution)
- Order: node:* builtins → npm packages → internal (type imports before value imports from same module)

## Patterns
- ESM module system (`"type": "module"`)
- TypeScript strict mode enabled
- Double quotes for import specifiers and property keys; single quotes for display strings
- Numeric literals: underscore-separated thousands (`32_000`, `120_000`)
- Error handling: Result/Decision union types for validation; throw-based for operational errors
- Module-level helper functions preferred over unnecessary classes
- No blank lines between import groups in smaller files

## Entries
