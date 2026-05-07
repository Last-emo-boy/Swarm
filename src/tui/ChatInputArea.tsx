import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  applyChatInputKey,
  chatInputCompletionCandidates,
  chatInputCompletionRows,
  createChatInputControllerState,
  selectedChatInputCompletionIndex,
  type ChatInputControllerState
} from "./chat-input-controller.js";
import type { SlashCommandSpec } from "./slash-commands.js";

const INPUT_RENDER_ROWS = 4;

export function ChatInputArea({
  onSubmit,
  onCompletionRowsChange
}: {
  onSubmit: (value: string) => void | Promise<void>;
  onCompletionRowsChange: (rows: number) => void;
}): React.ReactElement {
  const controllerState = useRef<ChatInputControllerState>(createChatInputControllerState());
  const [, setRenderVersion] = useState(0);
  const completionRows = chatInputCompletionRows(controllerState.current);
  const commandCandidates = chatInputCompletionCandidates(controllerState.current);
  const selectedCompletionIndex = selectedChatInputCompletionIndex(controllerState.current);

  useEffect(() => {
    onCompletionRowsChange(completionRows);
  }, [completionRows, onCompletionRowsChange]);

  useEffect(() => () => onCompletionRowsChange(0), [onCompletionRowsChange]);

  useInput((character, key) => {
    const previousState = controllerState.current;
    const result = applyChatInputKey(previousState, character, key);
    controllerState.current = result.state;
    if (result.state !== previousState || result.submit) {
      setRenderVersion((version) => version + 1);
    }
    if (result.submit) {
      void onSubmit(result.submit);
    }
  });

  return (
    <>
      {commandCandidates.length > 0 && (
        <CommandCandidates candidates={commandCandidates} selectedIndex={selectedCompletionIndex} />
      )}

      <Box marginTop={1}>
        <Text color="green">&gt; </Text>
        <InputLine value={controllerState.current.input.value} cursor={controllerState.current.input.cursor} />
      </Box>
    </>
  );
}

function InputLine({ value, cursor }: { value: string; cursor: number }): React.ReactElement {
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const viewport = inputViewport(value, safeCursor, INPUT_RENDER_ROWS);
  const before = viewport.value.slice(0, viewport.cursor);
  const current = viewport.value[viewport.cursor] ?? " ";
  const after = viewport.value.slice(viewport.cursor + (viewport.value[viewport.cursor] ? 1 : 0));
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{current}</Text>
      <Text>{after}</Text>
    </>
  );
}

function inputViewport(value: string, cursor: number, maxRows: number): { value: string; cursor: number } {
  if (!value.includes("\n")) {
    return { value, cursor };
  }
  const lineStarts = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  const cursorLine = Math.max(0, lineStarts.findIndex((start, index) => cursor >= start && (index === lineStarts.length - 1 || cursor < lineStarts[index + 1])));
  const startLine = Math.max(0, cursorLine - maxRows + 1);
  const start = lineStarts[startLine] ?? 0;
  const nextLineStart = lineStarts[Math.min(lineStarts.length - 1, cursorLine + 1)];
  const cursorLineEnd = nextLineStart === undefined ? value.length : Math.max(start, nextLineStart - 1);
  const prefix = start > 0 ? "... " : "";
  const visible = value.slice(start, cursorLineEnd).replace(/\n/g, " / ");
  return {
    value: `${prefix}${visible}`,
    cursor: prefix.length + Math.max(0, Math.min(cursor - start, visible.length))
  };
}

function CommandCandidates({ candidates, selectedIndex }: { candidates: SlashCommandSpec[]; selectedIndex: number }): React.ReactElement {
  return (
    <Box marginTop={1} borderStyle="single" paddingX={1} flexDirection="column">
      <Text color="gray">slash commands  Up/Down select  Tab accepts  Esc closes</Text>
      {candidates.slice(0, 4).map((candidate, index) => (
        <Text key={candidate.name} color={index === selectedIndex ? "cyan" : undefined} wrap="truncate">
          {index === selectedIndex ? ">" : " "} {candidate.usage} <Text color="gray">[{candidate.group}] {candidate.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
