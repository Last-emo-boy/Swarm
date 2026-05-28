# F-005: Result Preview And Product Result Card Continuity

Priority: P1

## Purpose

Make the final settlement view feel grown from the run, not generated after the fact.

## Scope

Add a running `ResultPreview` from RunBoard selectors. Later extend the existing `ResultCard` model/rendering with contribution and blocker summaries when evidence is reliable. Do not fork `src/runtime/result-card.ts` or `src/tui/components/ResultCard.tsx`.

## Owned Files

- `src/tui/run-board/ResultPreview.tsx`
- `src/tui/run-board/run-board-selectors.ts`
- `src/runtime/result-card.ts`
- `src/tui/components/ResultCard.tsx`

## Dependencies

- F-001
- F-006

## Acceptance

- Preview and final card share changed files, checks, risks, blockers, artifacts, and next actions.
- Worker contributions render only when evidence exists.
- Existing ResultCard behavior is preserved.

## Tests

Add preview-to-final selector tests and component rendering tests that compare shared evidence across busy and finished states.
