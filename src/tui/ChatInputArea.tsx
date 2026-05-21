import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  applyChatInputKey,
  CHAT_INPUT_COMPLETION_VISIBLE_ROWS,
  chatInputCompletionCandidates,
  chatInputCompletionRows,
  createChatInputControllerState,
  selectedChatInputCompletionIndex,
  type ChatInputControllerState
} from "./chat-input-controller.js";
import type { SlashCommandSpec } from "./slash-commands.js";
import { INPUT_RENDER_ROWS, renderInputLineParts, visibleInputRows } from "./input-rendering.js";
import { displayWidth, sliceByDisplayWidth } from "./display-width.js";
import type { FooterPill, FooterPillId } from "./footer-navigation.js";

const CHAT_INPUT_CHROME_ROWS = 4;
const CHAT_INPUT_OVERLAY_COMPLETION_ROWS = 5;
const PROMPT_POINTER = "❯\u00A0";

export function ChatInputArea({
  onSubmit,
  onCompletionRowsChange,
  onCompletionStateChange,
  controllerStateRef,
  extraCommands = [],
  promptLabel,
  sandboxLabel,
  placeholder = "Ask Swarm",
  footerHint = "? for shortcuts",
  footerItems = [],
  selectedFooterItem,
  inputActive = true,
  completionPlacement = "inline",
  maxRows,
  maxInputRows,
  maxCompletionRows
}: {
  onSubmit: (value: string) => void | Promise<void>;
  onCompletionRowsChange: (rows: number) => void;
  onCompletionStateChange?: (state: ChatCompletionState) => void;
  controllerStateRef?: React.MutableRefObject<ChatInputControllerState>;
  extraCommands?: SlashCommandSpec[];
  promptLabel?: string;
  sandboxLabel?: string;
  placeholder?: string;
  footerHint?: string | false;
  footerItems?: FooterPill[];
  selectedFooterItem?: FooterPillId;
  inputActive?: boolean;
  completionPlacement?: "inline" | "overlay";
  maxRows?: number;
  maxInputRows?: number;
  maxCompletionRows?: number;
}): React.ReactElement {
  const internalControllerState = useRef<ChatInputControllerState>(createChatInputControllerState());
  const controllerState = controllerStateRef ?? internalControllerState;
  const [renderVersion, setRenderVersion] = useState(0);
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

  useEffect(() => {
    onCompletionRowsChange(bottomExtraRows);
  }, [bottomExtraRows, onCompletionRowsChange]);

  useEffect(() => {
    onCompletionStateChange?.({
      candidates: commandCandidates,
      selectedIndex: selectedCompletionIndex,
      signature: completionSignature
    });
  }, [completionSignature, onCompletionStateChange, renderVersion]);

  useEffect(() => () => onCompletionRowsChange(0), [onCompletionRowsChange]);

  useInput((character, key) => {
    const previousState = controllerState.current;
    const result = applyChatInputKey(previousState, character, key, completionOptions);
    controllerState.current = result.state;
    if (result.state !== previousState || result.submit) {
      setRenderVersion((version) => version + 1);
    }
    if (result.submit) {
      void onSubmit(result.submit);
    }
  }, { isActive: inputActive });

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
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
        borderColor="gray"
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        {(promptLabel || sandboxLabel) && (
          <Text color="gray">{inputStatusPrefix(promptLabel, sandboxLabel)} </Text>
        )}
        <Text>{PROMPT_POINTER}</Text>
        <Box flexGrow={1} flexShrink={1} flexDirection="column">
          <InputLine
            value={controllerState.current.input.value}
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
      />
    </Box>
  );
}

function inputStatusPrefix(promptLabel: string | undefined, sandboxLabel: string | undefined): string {
  return [promptLabel, sandboxLabel].filter(Boolean).join(" ");
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
        <Text color="gray">{placeholder}</Text>
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

export function ChatInputFooter({ inputValue, footerHint, footerItems, selectedFooterItem }: {
  inputValue: string;
  footerHint: string | false;
  footerItems: FooterPill[];
  selectedFooterItem?: FooterPillId;
}): React.ReactElement | null {
  if (footerHint === false && footerItems.length === 0) {
    return null;
  }
  const hint = inputValue.length > 0 ? "" : footerHint || "";
  return (
    <Box width="100%" paddingX={2} flexDirection="row" flexShrink={0}>
      {footerItems.length > 0 ? (
        <Text wrap="truncate">
          {footerItems.map((item, index) => (
            <React.Fragment key={item.id}>
              {index > 0 ? <Text color="gray"> </Text> : null}
              <Text
                inverse={item.id === selectedFooterItem}
                color={footerPillColor(item.tone)}
              >
                {`${item.label}:${item.value}`}
              </Text>
            </React.Fragment>
          ))}
          {hint ? <Text color="gray">  {hint}</Text> : null}
        </Text>
      ) : (
        <Text color="gray" wrap="truncate">
          {hint}
        </Text>
      )}
    </Box>
  );
}

function footerPillColor(tone: FooterPill["tone"]): "cyan" | "green" | "yellow" | "red" | "gray" | "white" {
  if (tone === "running") return "cyan";
  if (tone === "success") return "green";
  if (tone === "pending" || tone === "warning") return "yellow";
  if (tone === "danger") return "red";
  if (tone === "muted") return "gray";
  return "white";
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
  return (
    <Box
      marginTop={overlay ? 0 : 1}
      borderStyle={overlay ? undefined : "single"}
      borderColor="cyan"
      paddingX={overlay ? 0 : 1}
      flexDirection="column"
      width="100%"
    >
      {!overlay && (
        <Text wrap="truncate">
          <Text color="cyan" bold>Command Palette</Text>
          <Text color="gray">  Up/Down select | Tab accept | Esc close</Text>
        </Text>
      )}
      {visible.map((candidate, visibleIndex) => {
        const index = startIndex + visibleIndex;
        return (
        <Text key={candidate.name} color={index === selectedIndex ? "cyan" : undefined} wrap="truncate">
          {overlay
            ? fillTerminalLine(`${index === selectedIndex ? "› " : "  "}${candidate.usage}  ${candidate.group} | ${candidate.description}`, contentColumns)
            : (
              <>
                {index === selectedIndex ? "> " : "  "}
                <Text bold={index === selectedIndex}>{candidate.usage}</Text>
                <Text color="gray">  {candidate.group} | {candidate.description}</Text>
              </>
            )}
        </Text>
        );
      })}
      {!overlay && hidden > 0 && (
        <Text color="gray">
          {`    ... ${hidden} more commands`}
        </Text>
      )}
    </Box>
  );
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

function fillTerminalLine(value: string, columns: number): string {
  const width = Math.max(1, Math.floor(columns));
  const normalized = value.replace(/\s+/gu, " ").trimEnd();
  const sliced = displayWidth(normalized) > width
    ? sliceByDisplayWidth(normalized, Math.max(1, width - 1)).head
    : normalized;
  return `${sliced}${" ".repeat(Math.max(0, width - displayWidth(sliced)))}`;
}
