import React, { useEffect, useRef, useState } from "react";
import { Box, Text, resolveTuiRendererMode, useInput } from "./ui.js";
import {
  applyChatInputKey,
  CHAT_INPUT_COMPLETION_VISIBLE_ROWS,
  chatInputCompletionCandidates,
  chatInputCompletionRows,
  createChatInputControllerState,
  isChatInputPromptKey,
  selectedChatInputCompletionIndex,
  type ChatInputKey,
  type ChatInputControllerState
} from "./chat-input-controller.js";
import type { SlashCommandSpec } from "./slash-commands.js";
import { INPUT_RENDER_ROWS, renderInputLineParts, visibleInputRows } from "./input-rendering.js";
import { displayWidth, sliceByDisplayWidth } from "./display-width.js";
import type { FooterPill, FooterPillId } from "./footer-navigation.js";
import { shortcutHint, shortcutLabel } from "./shortcuts.js";
import type { TuiDensity } from "./conversation-layout.js";
import { visualTokenColor, type TuiColorRef } from "./theme.js";
import { TonePill } from "./components/TonePill.js";

const CHAT_INPUT_CHROME_ROWS = 4;
const CHAT_INPUT_OVERLAY_COMPLETION_ROWS = 5;
const PROMPT_POINTER = "❯\u00A0";

export function ChatInputArea({
  onSubmit,
  onEmptyShortcut,
  onCompletionRowsChange,
  onCompletionStateChange,
  onInputTelemetry,
  controllerStateRef,
  extraCommands = [],
  promptLabel,
  sandboxLabel,
  placeholder = "Ask Swarm",
  footerHint = shortcutLabel("prompt.shortcuts"),
  footerItems = [],
  selectedFooterItem,
  footerModeLabel,
  footerModeTone,
  footerPermissionLabel,
  footerPermissionTone,
  footerSandboxLabel,
  footerSandboxTone,
  footerActivityLabel,
  footerActivityValue,
  footerActivityTone,
  onFooterItemClick,
  inputActive = true,
  completionPlacement = "inline",
  density = "default",
  columns,
  maxRows,
  maxInputRows,
  maxCompletionRows
}: {
  onSubmit: (value: string) => void | Promise<void>;
  onEmptyShortcut?: (character: string | undefined, key: ChatInputEmptyShortcutKey) => boolean;
  onCompletionRowsChange: (rows: number) => void;
  onCompletionStateChange?: (state: ChatCompletionState) => void;
  onInputTelemetry?: (event: ChatInputTelemetryEvent) => void;
  controllerStateRef?: React.MutableRefObject<ChatInputControllerState>;
  extraCommands?: SlashCommandSpec[];
  promptLabel?: string;
  sandboxLabel?: string;
  placeholder?: string;
  footerHint?: string | false;
  footerItems?: FooterPill[];
  selectedFooterItem?: FooterPillId;
  footerModeLabel?: string;
  footerModeTone?: TuiColorRef;
  footerPermissionLabel?: string;
  footerPermissionTone?: TuiColorRef;
  footerSandboxLabel?: string;
  footerSandboxTone?: TuiColorRef;
  footerActivityLabel?: string;
  footerActivityValue?: string;
  footerActivityTone?: TuiColorRef;
  onFooterItemClick?: (id: FooterPillId) => void;
  inputActive?: boolean;
  completionPlacement?: "inline" | "overlay";
  density?: TuiDensity;
  columns?: number;
  maxRows?: number;
  maxInputRows?: number;
  maxCompletionRows?: number;
}): React.ReactElement {
  const internalControllerState = useRef<ChatInputControllerState>(createChatInputControllerState());
  const controllerState = controllerStateRef ?? internalControllerState;
  const reportedCompletionSignature = useRef<string | undefined>();
  const [, setRenderVersion] = useState(0);
  const completionOptions = { extraCommands };
  const rowBudget = maxRows === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(maxRows) - CHAT_INPUT_CHROME_ROWS);
  const inputRowLimit = maxRows === undefined
    ? maxInputRows
    : Math.max(1, Math.min(maxInputRows ?? INPUT_RENDER_ROWS, rowBudget + 1));
  const desiredInputRows = visibleInputRows(
    controllerState.current.input.value,
    controllerState.current.input.cursor,
    maxInputRows ?? INPUT_RENDER_ROWS
  );
  const completionRowBudget = maxRows === undefined
    ? maxCompletionRows
    : Math.max(0, rowBudget);
  const completionRows = completionPlacement === "inline"
    ? boundedCompletionRows(controllerState.current, completionOptions, completionRowBudget)
    : 0;
  const bottomExtraRows = completionRows + Math.max(0, desiredInputRows - 1);
  const commandCandidates = chatInputCompletionCandidates(controllerState.current, completionOptions);
  const selectedCompletionIndex = selectedChatInputCompletionIndex(controllerState.current, completionOptions);
  const completionSignature = completionStateSignature(commandCandidates, selectedCompletionIndex);
  const domRendererActive = resolveTuiRendererMode() === "dom-renderer";
  const [domFocused, setDomFocused] = useState(false);
  const promptFocused = inputActive && (!domRendererActive || domFocused);
  const promptTone = promptFocused ? visualTokenColor("brand.focus") : visualTokenColor("surface.line");

  function handlePromptInput(character: string | undefined, key: ChatInputEmptyShortcutKey): boolean {
    if (!inputActive) {
      return false;
    }
    const previousState = controllerState.current;
    if (previousState.input.value.length === 0 && onEmptyShortcut?.(character, key)) {
      return true;
    }
    if (!isChatInputPromptKey(character, key)) {
      return false;
    }
    const result = applyChatInputKey(previousState, character, key, completionOptions);
    controllerState.current = result.state;
    const changed = result.state !== previousState;
    if (result.state !== previousState || result.submit) {
      setRenderVersion((version) => version + 1);
    }
    onInputTelemetry?.({
      key: chatInputKeyLabel(character, key),
      inputLength: character?.length ?? 0,
      promptLengthBefore: previousState.input.value.length,
      promptLengthAfter: result.state.input.value.length,
      cursorBefore: previousState.input.cursor,
      cursorAfter: result.state.input.cursor,
      changed,
      submitted: Boolean(result.submit),
      completionOpen: commandCandidates.length > 0,
      source: domRendererActive ? "dom-renderer" : "hook"
    });
    if (result.submit) {
      void onSubmit(result.submit);
    }
    return true;
  }

  const rendererInputProps = domRendererActive
    ? ({
      focusable: inputActive,
      onFocus: () => setDomFocused(true),
      onBlur: () => setDomFocused(false),
      onKeydown: (event: { input?: string; key?: ChatInputEmptyShortcutKey; preventDefault: () => void }) => {
        if (handlePromptInput(event.input, event.key ?? {})) {
          event.preventDefault();
        }
      }
    } as never)
    : {};

  useEffect(() => {
    onCompletionRowsChange(bottomExtraRows);
  }, [bottomExtraRows, onCompletionRowsChange]);

  useEffect(() => {
    if (reportedCompletionSignature.current === completionSignature) {
      return;
    }
    reportedCompletionSignature.current = completionSignature;
    onCompletionStateChange?.({
      candidates: commandCandidates,
      selectedIndex: selectedCompletionIndex,
      signature: completionSignature
    });
  }, [completionSignature, onCompletionStateChange]);

  useEffect(() => () => onCompletionRowsChange(0), [onCompletionRowsChange]);

  useEffect(() => {
    if (!inputActive) {
      setDomFocused(false);
    }
  }, [inputActive]);

  useInput((character, key) => {
    handlePromptInput(character, key);
  }, { isActive: inputActive });

  return (
    <Box {...rendererInputProps} flexDirection="column" width="100%" flexShrink={0}>
      {completionPlacement === "inline" && commandCandidates.length > 0 && (
        <ChatCommandCandidates
          candidates={commandCandidates}
          selectedIndex={selectedCompletionIndex}
          maxRows={completionRowBudget}
        />
      )}

      <Box
        width="100%"
        flexDirection="row"
        alignItems="flex-start"
        borderStyle="round"
        borderColor={promptTone}
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        {(promptLabel || sandboxLabel) && (
          <Text color={visualTokenColor("text.muted")}>{inputStatusPrefix(promptLabel, sandboxLabel, density)} </Text>
        )}
        <Text color={visualTokenColor("role.user")}>{PROMPT_POINTER}</Text>
        <Box flexGrow={1} flexShrink={1} flexDirection="column">
          <InputLine value={controllerState.current.input.value}
            cursor={controllerState.current.input.cursor}
            placeholder={placeholder}
            maxRows={inputRowLimit}
          />
        </Box>
      </Box>
      <ChatInputFooter
        inputValue={controllerState.current.input.value}
        footerHint={footerHint}
        footerItems={footerItems}
        selectedFooterItem={selectedFooterItem}
        modeLabel={footerModeLabel ?? promptLabel}
        modeTone={footerModeTone}
        permissionLabel={footerPermissionLabel}
        permissionTone={footerPermissionTone}
        sandboxLabel={footerSandboxLabel ?? sandboxLabel}
        sandboxTone={footerSandboxTone}
        activityLabel={footerActivityLabel}
        activityValue={footerActivityValue}
        activityTone={footerActivityTone}
        onFooterItemClick={onFooterItemClick}
        density={density}
        columns={columns}
      />
    </Box>
  );
}

function inputStatusPrefix(promptLabel: string | undefined, sandboxLabel: string | undefined, density: TuiDensity): string {
  const labels = [promptLabel, sandboxLabel].filter((label): label is string => Boolean(label?.trim()));
  if (labels.length === 0) {
    return "";
  }
  const normalized = labels.map((label) => normalizeModeLabel(label, density));
  return `[${normalized.join(" ")}]`;
}

function normalizeModeLabel(label: string, density: TuiDensity): string {
  const normalized = label.trim().replace(/\s+/gu, "-").toUpperCase();
  if (density !== "compact") {
    return normalized;
  }
  if (normalized === "WORKSPACE-WRITE") {
    return "RW";
  }
  if (normalized === "READ-ONLY") {
    return "RO";
  }
  return normalized.length > 10 ? normalized.slice(0, 10) : normalized;
}

function InputLine({ value, cursor, placeholder, maxRows }: {
  value: string;
  cursor: number;
  placeholder: string;
  maxRows?: number;
}): React.ReactElement {
  if (!value) {
    return (
      <Text wrap="truncate">
        <Text inverse> </Text>
        <Text color={visualTokenColor("text.muted")}>{placeholder}</Text>
      </Text>
    );
  }
  const { before, current, after } = renderInputLineParts(value, cursor, maxRows);
  return (
    <Text wrap="wrap">
      <Text>{before}</Text>
      <Text inverse>{current}</Text>
      <Text>{after}</Text>
    </Text>
  );
}

export type ChatCompletionState = {
  candidates: SlashCommandSpec[];
  selectedIndex: number;
  signature: string;
};

export type ChatInputTelemetryEvent = {
  key: string;
  inputLength: number;
  promptLengthBefore: number;
  promptLengthAfter: number;
  cursorBefore: number;
  cursorAfter: number;
  changed: boolean;
  submitted: boolean;
  completionOpen: boolean;
  source: "dom-renderer" | "hook";
};

function chatInputKeyLabel(character: string | undefined, key: ChatInputKey): string {
  if (key.ctrl) {
    return character ? `ctrl+${character}` : "ctrl";
  }
  if (key.meta) return "meta";
  if (key.return) return "return";
  if (key.escape) return "escape";
  if (key.tab) return "tab";
  if (key.backspace) return "backspace";
  if (key.delete) return "delete";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  return character ? "text" : "unknown";
}

type FooterDisplayPill = {
  key: string;
  label: string;
  value?: string;
  tone: TuiColorRef;
  selected?: boolean;
};

type ChatInputEmptyShortcutKey = ChatInputKey & {
  home?: boolean;
  end?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  shift?: boolean;
  alt?: boolean;
};

type FooterLayout = {
  left: FooterDisplayPill[];
  rightHint: string;
  leftWidth: number;
  hintWidth: number;
  spacerWidth: number;
  compact: boolean;
};

export function ChatInputFooter({
  inputValue,
  footerHint,
  footerItems,
  selectedFooterItem,
  modeLabel,
  modeTone,
  permissionLabel,
  permissionTone,
  sandboxLabel,
  sandboxTone,
  activityLabel,
  activityValue,
  activityTone,
  onFooterItemClick,
  density = "default",
  columns
}: {
  inputValue: string;
  footerHint: string | false;
  footerItems: FooterPill[];
  selectedFooterItem?: FooterPillId;
  modeLabel?: string;
  modeTone?: TuiColorRef;
  permissionLabel?: string;
  permissionTone?: TuiColorRef;
  sandboxLabel?: string;
  sandboxTone?: TuiColorRef;
  activityLabel?: string;
  activityValue?: string;
  activityTone?: TuiColorRef;
  onFooterItemClick?: (id: FooterPillId) => void;
  density?: TuiDensity;
  columns?: number;
}): React.ReactElement | null {
  const activityPills = footerActivityPills({ activityLabel, activityValue, activityTone });
  const statusPills = footerStatusPills({
    modeLabel,
    modeTone,
    permissionLabel,
    permissionTone,
    sandboxLabel,
    sandboxTone,
    density
  });
  const itemPills = prioritizedFooterItemPills(footerItems, selectedFooterItem);
  const allPills = [...activityPills, ...statusPills, ...itemPills];
  if (footerHint === false && allPills.length === 0) {
    return null;
  }
  const hint = inputValue.length > 0 || activityPills.length > 0 ? "" : footerHint || "";
  const layout = footerControlSurfaceLayout(allPills, hint, columns, density);
  return (
    <Box
      width="100%"
      paddingX={2}
      flexDirection={layout.compact ? "column" : "row"}
      justifyContent="flex-start"
      flexShrink={0}
    >
      <FooterPillZone pills={layout.left} onFooterItemClick={onFooterItemClick} />
      {!layout.compact && layout.rightHint ? (
        <Text color={visualTokenColor("text.muted")}>
          {" ".repeat(layout.spacerWidth)}
        </Text>
      ) : null}
      {!layout.compact && layout.rightHint ? (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          {layout.rightHint}
        </Text>
      ) : null}
    </Box>
  );
}

function FooterPillZone({ pills, onFooterItemClick }: {
  pills: FooterDisplayPill[];
  onFooterItemClick?: (id: FooterPillId) => void;
}): React.ReactElement {
  return (
    <Box flexDirection="row">
      {pills.map((item, index) => (
        <React.Fragment key={item.key}>
          {index > 0 ? <Text color={visualTokenColor("text.muted")}> </Text> : null}
          <FooterPillView item={item} onFooterItemClick={onFooterItemClick} />
        </React.Fragment>
      ))}
    </Box>
  );
}

function FooterPillView({ item, onFooterItemClick }: {
  item: FooterDisplayPill;
  onFooterItemClick?: (id: FooterPillId) => void;
}): React.ReactElement {
  if (isFooterPillId(item.key) && onFooterItemClick) {
    const id = item.key;
    return (
      <TonePill
        label={item.label}
        value={item.value}
        tone={item.tone}
        selected={item.selected}
        focusable
        onClick={() => onFooterItemClick(id)}
      />
    );
  }
  return (
    <TonePill
      label={item.label}
      value={item.value}
      tone={item.tone}
      selected={item.selected}
    />
  );
}

function isFooterPillId(value: string): value is FooterPillId {
  return value === "tasks" ||
    value === "approvals" ||
    value === "cache" ||
    value === "gateway" ||
    value === "mcp" ||
    value === "skills" ||
    value === "symphony" ||
    value === "lsp";
}

function footerActivityPills(input: {
  activityLabel?: string;
  activityValue?: string;
  activityTone?: TuiColorRef;
}): FooterDisplayPill[] {
  if (!input.activityLabel?.trim()) {
    return [];
  }
  return [{
    key: "activity",
    label: normalizeFooterActivityLabel(input.activityLabel),
    value: input.activityValue?.trim() || undefined,
    tone: input.activityTone ?? "status.running"
  }];
}

function normalizeFooterActivityLabel(label: string): string {
  return label.trim().replace(/\s+/gu, "-").toLowerCase();
}

function footerStatusPills(input: {
  modeLabel?: string;
  modeTone?: TuiColorRef;
  permissionLabel?: string;
  permissionTone?: TuiColorRef;
  sandboxLabel?: string;
  sandboxTone?: TuiColorRef;
  density: TuiDensity;
}): FooterDisplayPill[] {
  return [
    input.modeLabel ? {
      key: "mode",
      label: normalizeFooterLabel(input.modeLabel, input.density),
      tone: input.modeTone ?? "text.primary"
    } : undefined,
    input.permissionLabel ? {
      key: "permission",
      label: normalizeFooterLabel(input.permissionLabel, input.density),
      tone: input.permissionTone ?? "status.warning"
    } : undefined,
    input.sandboxLabel ? {
      key: "sandbox",
      label: normalizeFooterLabel(input.sandboxLabel, input.density),
      tone: input.sandboxTone ?? "status.success"
    } : undefined
  ].filter((item): item is FooterDisplayPill => Boolean(item?.label));
}

function normalizeFooterLabel(label: string, density: TuiDensity): string {
  return normalizeModeLabel(label, density === "comfortable" ? "default" : "compact");
}

function prioritizedFooterItemPills(items: FooterPill[], selectedFooterItem: FooterPillId | undefined): FooterDisplayPill[] {
  const priority = new Map<FooterPillId, number>([
    ["approvals", 0],
    ["cache", 1],
    ["lsp", 2],
    ["gateway", 3],
    ["symphony", 4],
    ["tasks", 5]
  ]);
  return [...items]
    .sort((left, right) => {
      if (left.id === selectedFooterItem) return -1;
      if (right.id === selectedFooterItem) return 1;
      const leftActive = left.tone !== "muted" && left.tone !== "neutral";
      const rightActive = right.tone !== "muted" && right.tone !== "neutral";
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return (priority.get(left.id) ?? 99) - (priority.get(right.id) ?? 99);
    })
    .map((item) => ({
      key: item.id,
      label: item.label,
      value: item.value,
      tone: footerPillTone(item.tone),
      selected: item.id === selectedFooterItem
    }));
}

function footerPillTone(tone: FooterPill["tone"]): TuiColorRef {
  if (tone === "running") return "status.running";
  if (tone === "success") return "status.success";
  if (tone === "pending") return "status.pending";
  if (tone === "warning") return "status.warning";
  if (tone === "danger") return "status.danger";
  if (tone === "muted") return "text.muted";
  return "text.primary";
}

function footerControlSurfaceLayout(
  pills: FooterDisplayPill[],
  hint: string,
  columns: number | undefined,
  _density: TuiDensity
): FooterLayout {
  const knownColumns = columns !== undefined && Number.isFinite(columns);
  const contentColumns = knownColumns ? Math.max(1, Math.floor(columns) - 4) : 40;
  const hintWidth = displayWidth(hint);
  const compact = !knownColumns || contentColumns <= 76;
  const displayPills = compact ? compactFooterDisplayPills(pills) : pills;
  if (compact) {
    const visible = fitFooterPills(displayPills, contentColumns);
    return {
      left: visible,
      rightHint: "",
      leftWidth: footerPillsWidth(visible),
      hintWidth: 0,
      spacerWidth: 0,
      compact: true
    };
  }

  const keepHint = hint.length > 0 && (contentColumns >= hintWidth + 10 || pills.length === 0);
  const pillBudget = keepHint ? Math.max(0, contentColumns - hintWidth - 2) : contentColumns;
  const visible = fitFooterPills(displayPills, pillBudget);
  const leftWidth = footerPillsWidth(visible);
  const visibleHintWidth = keepHint ? hintWidth : 0;
  return {
    left: visible,
    rightHint: keepHint ? hint : "",
    leftWidth,
    hintWidth: visibleHintWidth,
    spacerWidth: keepHint ? Math.max(2, contentColumns - leftWidth - visibleHintWidth) : 0,
    compact: false
  };
}

function fitFooterPills(items: FooterDisplayPill[], columns: number): FooterDisplayPill[] {
  if (columns <= 0) {
    return [];
  }
  const result: FooterDisplayPill[] = [];
  let used = 0;
  const selected = items.find((item) => item.selected);
  for (const item of items) {
    const width = footerPillWidth(item) + (result.length > 0 ? 1 : 0);
    const selectedNotPlaced = selected !== undefined && item !== selected && !result.includes(selected);
    const selectedReserve = selectedNotPlaced
      ? footerPillWidth(selected) + (result.length > 0 ? 1 : 0)
      : 0;
    if (used + width + selectedReserve > columns) {
      continue;
    }
    result.push(item);
    used += width;
  }
  return result;
}

function compactFooterDisplayPills(items: FooterDisplayPill[]): FooterDisplayPill[] {
  const compacted = items.map((item) => ({
    ...item,
    label: compactFooterLabel(item.key, item.label),
    value: compactFooterValue(item.key, item.value)
  }));
  if (!compacted.some((item) => item.key === "activity")) {
    return compacted;
  }
  const rank = (item: FooterDisplayPill): number => {
    if (item.selected) return -1;
    if (item.key === "activity") return 0;
    if (item.key === "approvals") return 1;
    if (item.key === "cache") return 2;
    if (item.key === "lsp") return 3;
    if (item.key === "gateway") return 4;
    if (item.key === "symphony") return 5;
    if (item.key === "mode") return 6;
    if (item.key === "permission") return 7;
    if (item.key === "sandbox") return 8;
    if (item.key === "tasks") return 9;
    return 20;
  };
  return compacted.sort((left, right) => rank(left) - rank(right));
}

function compactFooterLabel(key: string, label: string): string {
  if (key === "approvals") return "ask";
  if (key === "gateway") return "gw";
  if (key === "symphony") return "sym";
  return label;
}

function compactFooterValue(key: string, value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  if (key === "lsp" && value.toUpperCase() === "NO PROVIDER") {
    return "NO PROV";
  }
  if (key === "activity") {
    return truncateDisplay(value, 14);
  }
  if (key === "symphony") {
    return truncateDisplay(value.replace(/\s+retry\b/giu, " r"), 10);
  }
  return truncateDisplay(value, 10);
}

function footerPillsWidth(items: FooterDisplayPill[]): number {
  return items.reduce((sum, item, index) => sum + footerPillWidth(item) + (index > 0 ? 1 : 0), 0);
}

function footerPillWidth(item: FooterDisplayPill): number {
  return displayWidth(`[${item.value ? `${item.label}:${item.value}` : item.label}]`);
}

export function emptyChatCompletionState(): ChatCompletionState {
  return {
    candidates: [],
    selectedIndex: 0,
    signature: ""
  };
}

export function ChatCommandCandidates({ candidates, selectedIndex, maxRows, columns, overlay = false }: {
  candidates: SlashCommandSpec[];
  selectedIndex: number;
  maxRows?: number;
  columns?: number;
  overlay?: boolean;
}): React.ReactElement | null {
  if (maxRows === 0) {
    return null;
  }
  const visibleRows = overlay
    ? overlayCompletionCandidateRows(candidates.length, maxRows)
    : completionCandidateRowLimit(candidates.length, maxRows);
  if (visibleRows <= 0) {
    return null;
  }
  const startIndex = overlay
    ? completionOverlayStartIndex(candidates.length, selectedIndex, visibleRows)
    : 0;
  const visible = candidates.slice(startIndex, startIndex + visibleRows);
  const hidden = Math.max(0, candidates.length - visible.length);
  const contentColumns = Math.max(10, Math.floor((columns ?? 100) - (overlay ? 0 : 2)));
  const columnWidth = commandCandidateNameColumnWidth(candidates, contentColumns);
  return (
    <Box
      marginTop={overlay ? 0 : 1}
      borderStyle={overlay ? undefined : "single"}
      borderColor={visualTokenColor("role.tool")}
      paddingX={overlay ? 0 : 1}
      flexDirection="column"
      width="100%"
    >
      {!overlay && (
        <Text wrap="truncate">
          <Text color={visualTokenColor("role.tool")} bold>Command Palette</Text>
          <Text color={visualTokenColor("text.muted")}>  {shortcutHint(["command.select", "command.accept", "command.close"])}</Text>
        </Text>
      )}
      {visible.map((candidate, visibleIndex) => {
        const index = startIndex + visibleIndex;
        return (
          <CommandCandidateRow
            key={candidate.name}
            candidate={candidate}
            selected={index === selectedIndex}
            overlay={overlay}
            columns={contentColumns}
            nameColumnWidth={columnWidth}
          />
        );
      })}
      {!overlay && hidden > 0 && (
        <Text color={visualTokenColor("text.muted")}>
          {`    ... ${hidden} more commands`}
        </Text>
      )}
    </Box>
  );
}

function CommandCandidateRow({
  candidate,
  selected,
  overlay,
  columns,
  nameColumnWidth
}: {
  candidate: SlashCommandSpec;
  selected: boolean;
  overlay: boolean;
  columns: number;
  nameColumnWidth: number;
}): React.ReactElement {
  const model = commandCandidateRowModel(candidate, {
    selected,
    overlay,
    columns,
    nameColumnWidth
  });
  return (
    <Text
      wrap="truncate"
      backgroundColor={selected ? visualTokenColor("surface.selection") : undefined}
      inverse={selected && visualTokenColor("surface.selection") === undefined}
    >
      <Text
        color={selected ? visualTokenColor("brand.focus") : visualTokenColor("text.muted")}
        backgroundColor={selected ? visualTokenColor("surface.selection") : undefined}
      >
        {model.pointer}
      </Text>
      <Text
        color={selected ? visualTokenColor("text.primary") : visualTokenColor("text.primary")}
        backgroundColor={selected ? visualTokenColor("surface.selection") : undefined}
        bold={selected}
      >
        {model.name}
      </Text>
      <Text
        color={selected ? visualTokenColor("role.tool") : visualTokenColor("text.muted")}
        backgroundColor={selected ? visualTokenColor("surface.selection") : undefined}
      >
        {model.group}
      </Text>
      <Text
        color={selected ? visualTokenColor("text.primary") : visualTokenColor("text.muted")}
        backgroundColor={selected ? visualTokenColor("surface.selection") : undefined}
      >
        {model.description}
      </Text>
    </Text>
  );
}

function commandCandidateRowModel(
  candidate: SlashCommandSpec,
  input: {
    selected: boolean;
    overlay: boolean;
    columns: number;
    nameColumnWidth: number;
  }
): {
  pointer: string;
  name: string;
  group: string;
  description: string;
} {
  const pointer = input.selected ? "› " : "  ";
  const groupLabel = `[${candidate.group}] `;
  const minDescriptionWidth = 8;
  const descriptionBudget = Math.max(
    0,
    input.columns - displayWidth(pointer) - input.nameColumnWidth - displayWidth(groupLabel)
  );
  const rawDescription = candidate.description.replace(/\s+/gu, " ").trim();
  const description = descriptionBudget > 0
    ? truncateDisplay(rawDescription, Math.max(minDescriptionWidth, descriptionBudget))
    : "";
  const used = displayWidth(pointer) + input.nameColumnWidth + displayWidth(groupLabel) + displayWidth(description);
  const fillWidth = Math.max(0, input.columns - used);
  return {
    pointer,
    name: padDisplay(truncateDisplay(candidate.usage, input.nameColumnWidth), input.nameColumnWidth),
    group: groupLabel,
    description: `${description}${" ".repeat(fillWidth)}`
  };
}

function commandCandidateNameColumnWidth(candidates: SlashCommandSpec[], columns: number): number {
  const longest = Math.max(0, ...candidates.map((candidate) => displayWidth(candidate.usage)));
  const maxName = Math.max(12, Math.floor(columns * 0.42));
  return Math.max(10, Math.min(longest + 2, maxName));
}

function completionCandidateRowLimit(candidateCount: number, maxRows: number | undefined): number {
  if (candidateCount <= 0) {
    return 0;
  }
  if (maxRows === undefined) {
    return Math.min(candidateCount, CHAT_INPUT_COMPLETION_VISIBLE_ROWS);
  }
  const rowBudget = Math.max(0, Math.floor(maxRows));
  if (rowBudget <= 4) {
    return 0;
  }
  const hiddenRow = candidateCount > 1 ? 1 : 0;
  return Math.max(1, Math.min(candidateCount, CHAT_INPUT_COMPLETION_VISIBLE_ROWS, rowBudget - 4 - hiddenRow));
}

function overlayCompletionCandidateRows(candidateCount: number, maxRows: number | undefined): number {
  if (candidateCount <= 0) {
    return 0;
  }
  const totalRows = Math.max(1, Math.floor(maxRows ?? CHAT_INPUT_OVERLAY_COMPLETION_ROWS));
  return Math.min(candidateCount, totalRows);
}

function completionOverlayStartIndex(candidateCount: number, selectedIndex: number, visibleRows: number): number {
  const maxStart = Math.max(0, candidateCount - visibleRows);
  const preferred = Math.max(0, selectedIndex - Math.floor(visibleRows / 2));
  return Math.min(preferred, maxStart);
}

function boundedCompletionRows(
  state: ChatInputControllerState,
  options: { extraCommands?: SlashCommandSpec[] },
  maxRows: number | undefined
): number {
  if (maxRows === undefined) {
    return chatInputCompletionRows(state, options);
  }
  const candidates = chatInputCompletionCandidates(state, options);
  const visibleRows = completionCandidateRowLimit(candidates.length, maxRows);
  if (visibleRows <= 0) {
    return 0;
  }
  const hiddenRow = candidates.length > visibleRows ? 1 : 0;
  return visibleRows + hiddenRow + 4;
}

function completionStateSignature(candidates: SlashCommandSpec[], selectedIndex: number): string {
  return `${selectedIndex}:${candidates.map((candidate) => candidate.name).join(",")}`;
}

function truncateDisplay(value: string, columns: number): string {
  const width = Math.max(1, Math.floor(columns));
  if (displayWidth(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return sliceByDisplayWidth(value, 1).head;
  }
  return `${sliceByDisplayWidth(value, width - 1).head}…`;
}

function padDisplay(value: string, columns: number): string {
  const width = Math.max(0, Math.floor(columns));
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}
