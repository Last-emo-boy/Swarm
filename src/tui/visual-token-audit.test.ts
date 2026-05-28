import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import test from "node:test";

const UI_SURFACE_FILES = [
  "src/tui/ChatInputArea.tsx",
  "src/tui/SwarmChatApp.tsx",
  "src/tui/components/ActionLog.tsx",
  "src/tui/components/ActivityTimeline.tsx",
  "src/tui/components/ApprovalOverlay.tsx",
  "src/tui/components/ConversationFirstPane.tsx",
  "src/tui/components/ConversationFullscreenLayout.tsx",
  "src/tui/components/ConversationLogo.tsx",
  "src/tui/components/CollaborationOverlayPanel.tsx",
  "src/tui/components/CurrentActionRow.tsx",
  "src/tui/components/InspectorPane.tsx",
  "src/tui/components/PlanApprovalOverlay.tsx",
  "src/tui/components/ResultCard.tsx",
  "src/tui/components/RoleMarker.tsx",
  "src/tui/components/SemanticTextLine.tsx",
  "src/tui/components/StatusIcon.tsx",
  "src/tui/components/StatusRail.tsx",
  "src/tui/components/ThemedBox.tsx",
  "src/tui/components/ThemedText.tsx",
  "src/tui/components/TonePill.tsx",
  "src/tui/components/TranscriptRow.tsx",
  "src/tui/components/VirtualConversationList.tsx"
] as const;

const BARE_COLOR_LITERAL = /(?<quote>["'])(?:cyan|gray|yellow|red|green|magenta|blue|white|brightCyan|brightGreen|brightYellow|brightRed|brightMagenta|brightBlue|brightWhite)\k<quote>/gu;

const ALLOWED_BARE_COLOR_CONTEXTS: Record<string, readonly RegExp[]> = {
  "src/tui/components/CurrentActionRow.tsx": [
    /color === defaultToneColor\("success"\)/u,
    /color === defaultToneColor\("pending"\)/u,
    /color === defaultToneColor\("danger"\)/u,
    /color === defaultToneColor\("running"\)/u
  ]
};

test("TUI UI surfaces use semantic visual tokens instead of bare ANSI colors", () => {
  const violations = UI_SURFACE_FILES.flatMap((file) => bareColorViolations(file));

  assert.deepEqual(violations, []);
});

test("collaboration role visual tokens are registered for color and monochrome labels", () => {
  const source = readFileSync("src/tui/theme.ts", "utf8");
  const roles = readFileSync("src/tui/collaboration-role.ts", "utf8");

  for (const token of ["role.planner", "role.worker", "role.reviewer", "role.aggregator"]) {
    assert.match(source, new RegExp(`"${token}"`, "u"));
  }
  for (const badge of ["[PLAN]", "[WORK]", "[REV]", "[AGG]"]) {
    assert.match(roles, new RegExp(badge.replace("[", "\\[").replace("]", "\\]"), "u"));
  }
});

function bareColorViolations(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const allowed = ALLOWED_BARE_COLOR_CONTEXTS[file] ?? [];
  const violations: string[] = [];
  for (const match of source.matchAll(BARE_COLOR_LITERAL)) {
    const lineNumber = 1 + source.slice(0, match.index).split(/\r?\n/u).length - 1;
    const line = source.split(/\r?\n/u)[lineNumber - 1]?.trim() ?? "";
    if (allowed.some((pattern) => pattern.test(line))) {
      continue;
    }
    violations.push(`${relative(process.cwd(), file)}:${lineNumber}: ${line}`);
  }
  return violations;
}
