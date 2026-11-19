/**
 * Per-scope admission matrix classifying incoming messages as explicit requests, inferred candidates, or ignored.
 * A listed sender who addresses the agent always makes an explicit request (no table cell). An unaddressed message is explicit only
 * where its row says so — a chat set to read every message, such as `otherChats: all`, admits one as the request it plainly is.
 */
import type { AdmissionCell } from "./core/model.js";

export type { AdmissionCell };
export type Admission = "explicit" | "inferred" | "ignore";
export const ADMISSION_OPTIONS = {
  listedUnaddressed: ["explicit", "inferred", "ignore"],
  unlistedAddressed: ["explicit", "inferred", "ignore"],
  unlistedUnaddressed: ["explicit", "inferred", "ignore"]
} as const satisfies Record<AdmissionCell, readonly Admission[]>;
export type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number] };
/** Defaults: unaddressed messages from listed senders are inferred candidates; unlisted senders are ignored. */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = {
  listedUnaddressed: "inferred",
  unlistedAddressed: "ignore",
  unlistedUnaddressed: "ignore"
};
