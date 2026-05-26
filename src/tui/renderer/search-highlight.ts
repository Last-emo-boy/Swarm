import type { TuiFrame } from "./frame.js";

export type TuiSearchMatch = {
  row: number;
  column: number;
  length: number;
  text: string;
};

export type SearchHighlightSegment = {
  text: string;
  match: boolean;
};

export function searchFrameText(frame: TuiFrame, query: string): TuiSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const matches: TuiSearchMatch[] = [];
  frame.screen.cells.forEach((row, rowIndex) => {
    const text = row.map((cell) => cell.char).join("");
    const lower = text.toLowerCase();
    let column = lower.indexOf(needle);
    while (column >= 0) {
      matches.push({
        row: rowIndex,
        column,
        length: needle.length,
        text: text.slice(column, column + needle.length)
      });
      column = lower.indexOf(needle, column + Math.max(1, needle.length));
    }
  });
  return matches;
}

export function splitSearchHighlightText(text: string, query: string | undefined): SearchHighlightSegment[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) {
    return text ? [{ text, match: false }] : [];
  }
  const haystack = text.toLowerCase();
  const segments: SearchHighlightSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = haystack.indexOf(needle, cursor);
    if (start < 0) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), match: false });
    }
    const end = start + needle.length;
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  return segments.filter((segment) => segment.text.length > 0);
}
