export type ApprovalInputKey = {
  ctrl?: boolean;
  escape?: boolean;
};

export type ApprovalInputDecision =
  | { handled: true; approved: boolean; rememberForSession: boolean }
  | { handled: false };

export function approvalInputDecision(character: string, key: ApprovalInputKey): ApprovalInputDecision {
  if (key.escape || (key.ctrl && character === "c")) {
    return { handled: true, approved: false, rememberForSession: false };
  }
  const value = character.toLowerCase();
  if (value !== "y" && value !== "n" && value !== "a" && value !== "d" && value !== "s") {
    return { handled: false };
  }
  // a (always) allows the same target for the rest of the session; s is the key it had before.
  return {
    handled: true,
    approved: value === "y" || value === "a" || value === "s",
    rememberForSession: value === "a" || value === "s"
  };
}
