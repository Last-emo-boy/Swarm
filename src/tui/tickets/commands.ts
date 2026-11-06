/**
 * The TUI's ticket commands: `/ticket <request>` files work for a ticket worker, `/ticket --on <node> <request>` runs its
 * worker on a paired node, `/ticket <id>` shows one, `/ticket say`, `stop` and `retry` act on one, and `/tickets` opens the
 * tickets pane.
 */
import type { TuiTickets } from "./controller.js";
import { needsYouItems, paneOrder, ticketDetailText, ticketsPillValue } from "./view-model.js";

export interface TicketCommandResult { brief: string; detail?: string; openPane?: boolean }

const USAGE = [
  "/ticket <request>          File a request; a ticket worker does it in its own directory",
  "/ticket @<device> <request> File it on a paired device, which then owns the ticket",
  "/ticket --on <node> <request> Keep the ticket here and run its worker on a paired node",
  "/ticket <id>               Show a ticket",
  "/ticket say <id> <text>    Send a message to a ticket, such as an answer to its question",
  "/ticket stop <id>          Stop a ticket's work",
  "/ticket retry <id>         Start a ticket again after it failed or blocked",
  "/tickets                   Open the tickets pane"
].join("\n");

/** A ticket handle: the start of a ticket id, as the TUI shows it, after `<device>:` for a paired device's ticket. */
const HANDLE = /^(?:[^\s:]+:)?[0-9a-f]{6,32}$/;

export async function runTicketCommand(tickets: TuiTickets, command: "ticket" | "tickets", args: string[]): Promise<TicketCommandResult> {
  if (command === "tickets") {
    const snapshot = await tickets.snapshot();
    const waiting = snapshot ? needsYouItems(snapshot.rows).length : 0;
    return { brief: snapshot ? `Tickets: ${ticketsPillValue(snapshot.status)}${waiting ? `; ${waiting} wait for you` : ""}.` : "No tickets yet. File one with /ticket <request>.", openPane: true };
  }
  const [first, ...rest] = args;
  if (!first || first === "help") {
    const snapshot = await tickets.snapshot();
    const rows = snapshot ? paneOrder(snapshot.rows).filter((row) => row.group !== "ended").slice(0, 12) : [];
    return {
      brief: snapshot ? `Tickets: ${ticketsPillValue(snapshot.status)}.` : "No tickets yet.",
      detail: [USAGE, "", ...rows.map((row) => `${row.short}  ${row.label.padEnd(22)} ${row.title}`)].join("\n")
    };
  }
  if (first === "say" || first === "stop" || first === "retry") {
    const handle = rest[0];
    if (!handle) throw new Error(`Usage: /ticket ${first} <id>${first === "say" ? " <text>" : ""}`);
    if (first === "say") {
      const text = rest.slice(1).join(" ").trim();
      if (!text) throw new Error("Usage: /ticket say <id> <text>");
      const row = await tickets.say(handle, text);
      const started = !row.device && await tickets.ensureHost();
      return { brief: `Sent to ticket ${row.short}: ${row.title}.${started ? " Started the ticket host in this TUI." : ""}` };
    }
    if (first === "stop") {
      const row = await tickets.stop(handle);
      return { brief: `Stopped ticket ${row.short}: ${row.title}.` };
    }
    const row = await tickets.retry(handle);
    const started = !row.device && await tickets.ensureHost();
    return { brief: `Retrying ticket ${row.short}: ${row.title}.${started ? " Started the ticket host in this TUI." : ""}` };
  }
  if (!rest.length && HANDLE.test(first) && tickets.available()) {
    const row = await tickets.find(first);
    if (row) return { brief: `Ticket ${row.short}: ${row.label} · ${row.title}`, detail: ticketDetailText(row, await tickets.messages(row.id)) };
  }
  if (first === "--on") {
    const [node, ...words] = rest;
    const text = words.join(" ").trim();
    if (!node || !text) throw new Error("Usage: /ticket --on <node> <request>");
    const { triggerId, placed, mesh } = await tickets.requestOn(text, node);
    // Only a mesh node's host places work on its peers; a host this TUI started would run the worker itself.
    return { brief: `Filed as a ticket request (${triggerId.slice(0, 8)}); its worker runs on ${placed}, and replies appear here.${mesh ? "" : " Start this device's node with `swarm node run` to place it there."}` };
  }
  if (first.startsWith("@") && first.length > 1) {
    const device = first.slice(1);
    const text = rest.join(" ").trim();
    if (!text) throw new Error("Usage: /ticket @<device> <request>");
    const { triggerId } = await tickets.request(text, device);
    return { brief: `Filed on ${device} as a ticket request (${triggerId.slice(0, 8)}). Its worker runs there; replies appear here.` };
  }
  const text = args.join(" ").trim();
  const { triggerId } = await tickets.request(text);
  const started = await tickets.ensureHost();
  return {
    brief: `Filed as a ticket request (${triggerId.slice(0, 8)}). A worker takes it in its own directory; replies appear here.${started ? " Started the ticket host in this TUI; it stops when you quit, or run `swarm superagent run` to keep one going." : ""}`
  };
}
