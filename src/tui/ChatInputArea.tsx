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
import { shortcutHint } from "./shortcuts.js";
import { visualTokenColor } from "./theme.js";

/** The rule above the prompt, the prompt line and the status line under it. */
const CHAT_INPUT_CHROME_ROWS = 3;
const CHAT_INPUT_OVERLAY_COMPLETION_ROWS = 5;
const PROMPT_POINTER = "› ";

/**
 * The prompt at the bottom of the conversation: a rule, the activity line while a run is busy, `› ` and what is typed,
 * and the status line. Modes and services do not show here: a mode that is not the default is in the header, the rest
 * in /status.
 */
export function ChatInputArea({
  onSubmit,
  onCompletionRowsChange,
  onCompletionStateChange,
  onInputTelemetry,
  controllerStateRef,
  extraCommands = [],
  placeholder = "Ask Swarm",
  activity,
  activityRows = 1,
  status,
  inputActive = true,
  completionPlacement = "inline",
  maxRows,
  maxInputRows,
  maxCompletionRows
}: {
  onSubmit: (value: string) => void | Promise<void>;
  onCompletionRowsChange: (rows: number) => void;
  onCompletionStateChange?: (state: ChatCompletionState) => void;
  onInputTelemetry?: (event: ChatInputTelemetryEvent) => void;
  controllerStateRef?: React.MutableRefObject<ChatInputControllerState>;
  extraCommands?: SlashCommandSpec[];
  placeholder?: string;
  /** The activity line, shown between the rule and the prompt while a run is busy; `activityRows` is its height. */
  activity?: React.ReactNode;
  activityRows?: number;
  /** The status line under the prompt; told whether the prompt is empty, since its hint gives way while typing. */
  status?: (input: { promptEmpty: boolean }) => React.ReactNode;
  inputActive?: boolean;
  completionPlacement?: "inline" | "overlay";
  maxRows?: number;
  maxInputRows?: number;
  maxCompletionRows?: number;
}): React.ReactElement {
  const internalControllerState = useRef<ChatInputControllerState>(createChatInputControllerState());
  const controllerState = controllerStateRef ?? internalControllerState;
  const reportedCompletionSignature = useRef<string | undefined>();
  const [renderVersion, setRenderVersion] = useState(0);
  const completionOptions = { extraCommands };
  const rowBudget = maxRows === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(maxRows) - CHAT_INPUT_CHROME_ROWS - (activity ? activityRows : 0));
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

  function handlePromptInput(character: string | undefined, key: ChatInputKey): boolean {
    if (!inputActive || !isChatInputPromptKey(character, key)) {
      return false;
    }
    const previousState = controllerState.current;
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
      onKeydown: (event: { input?: string; key?: ChatInputKey; preventDefault: () => void }) => {
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
        flexDirection="column"
        borderStyle="single"
        borderColor={promptTone}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        {activity ? <Box width="100%" paddingX={1}>{activity}</Box> : null}
        <Box width="100%" flexDirection="row" alignItems="flex-start" paddingX={1}>
          <Text color={promptFocused ? visualTokenColor("brand.focus") : visualTokenColor("text.muted")}>{PROMPT_POINTER}</Text>
          <Box flexGrow={1} flexShrink={1} flexDirection="column">
            <InputLine value={controllerState.current.input.value}
              cursor={controllerState.current.input.cursor}
              placeholder={placeholder}
              maxRows={inputRowLimit}
              focused={promptFocused}
            />
          </Box>
        </Box>
      </Box>
      {status ? status({ promptEmpty: controllerState.current.input.value.length === 0 }) : <Text> </Text>}
    </Box>
  );
}

function InputLine({ value, cursor, placeholder, maxRows, focused }: {
  value: string;
  cursor: number;
  placeholder: string;
  maxRows?: number;
  focused: boolean;
}): React.ReactElement {
  if (!value) {
    // The cursor sits on the placeholder's first letter, so the placeholder starts where typing will.
    return (
      <Text wrap="truncate">
        <Text inverse={focused} color={visualTokenColor("text.muted")}>{placeholder.slice(0, 1)}</Text>
        <Text color={visualTokenColor("text.muted")}>{placeholder.slice(1)}</Text>
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
