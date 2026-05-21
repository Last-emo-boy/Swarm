export type ResumeCommand = "resume" | "continue";
export type ResumeExecutionRoute = "stored_plan" | "coding_loop";

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
