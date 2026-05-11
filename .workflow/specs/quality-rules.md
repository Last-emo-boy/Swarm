---
title: "Quality Rules"
category: quality
---
# Quality Rules

Auto-generated from project analysis. Update manually as quality rules evolve.

## TypeScript
- Strict mode enabled (`tsconfig.json`: `"strict": true`)
- `forceConsistentCasingInFileNames`: true
- `skipLibCheck`: true

## CI
- GitHub Actions: push/PR to main triggers `npm run check` + `npm run build`
- Matrix: Node.js 24 only
- No test step in CI currently

## Code Quality
- No ESLint configuration
- No Prettier configuration
- No EditorConfig at project root
- Formatting consistency maintained manually

## Entries
