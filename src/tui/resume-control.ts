import { appendDetailShortcut } from "./shortcuts.js";

export type ResumeCommand = "resume" | "continue";
export type ResumeExecutionRoute = "stored_plan" | "coding_loop";
export type ResumeCommandResult = {
  brief: string;
  detail: string;
};

export function decideResumeExecution(input: {
  command: ResumeCommand;
  sessionId: string;
  hasStoredPlan: boolean;
  instruction: string;
}): { route: ResumeExecutionRoute; instruction: string } {
  const instruction = input.instruction.trim();
  if (input.hasStoredPlan && instruction) {
    throw new Error(
      `Cannot apply a new instruction while resuming stored plan ${input.sessionId}. Use /fork ${input.sessionId} <message> to branch the work, or rerun /${input.command} without a message.`
    );
  }
  return {
    route: input.hasStoredPlan ? "stored_plan" : "coding_loop",
    instruction
  };
}

export function buildResumeCommandResult(input: {
  command: ResumeCommand;
  sessionId: string;
  route: ResumeExecutionRoute;
  detail: string;
}): ResumeCommandResult {
  return {
    brief: appendDetailShortcut(
      `${input.command === "continue" ? "Continue" : "Resume"} started for ${input.sessionId}${input.route === "stored_plan" ? " from stored plan" : " through local coding loop"}`,
      "preflight"
    ),
    detail: input.detail
  };
}
