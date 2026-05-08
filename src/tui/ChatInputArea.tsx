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
import { renderInputLineParts } from "./input-rendering.js";

export function ChatInputArea({
  onSubmit,
  onCompletionRowsChange,
  controllerStateRef
}: {
  onSubmit: (value: string) => void | Promise<void>;
  onCompletionRowsChange: (rows: number) => void;
  controllerStateRef?: React.MutableRefObject<ChatInputControllerState>;
}): React.ReactElement {
  const internalControllerState = useRef<ChatInputControllerState>(createChatInputControllerState());
  const controllerState = controllerStateRef ?? internalControllerState;
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
  const { before, current, after } = renderInputLineParts(value, cursor);
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{current}</Text>
      <Text>{after}</Text>
    </>
  );
}

function CommandCandidates({ candidates, selectedIndex }: { candidates: SlashCommandSpec[]; selectedIndex: number }): React.ReactElement {
  return (
    <Box marginTop={1} borderStyle="single" paddingX={1} flexDirection="column">
      <Text color="gray">slash commands  Up/Down select  Tab accepts  Esc closes</Text>
      {candidates.slice(0, CHAT_INPUT_COMPLETION_VISIBLE_ROWS).map((candidate, index) => (
        <Text key={candidate.name} color={index === selectedIndex ? "cyan" : undefined} wrap="truncate">
          {index === selectedIndex ? ">" : " "} {candidate.usage} <Text color="gray">[{candidate.group}] {candidate.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
