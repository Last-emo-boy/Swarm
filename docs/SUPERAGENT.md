# Swarm Superagent

`src/superagent/` adapts DeepSeek's dsh-superagent prototype to Swarm. Upstream is a bundle for DeepSeek Harness;
here the same domain runs on Swarm's runtime, store and coding loop. This document maps the design onto Swarm and
names what differs. Upstream's numbered docs (000–008) remain the reference for the domain rules themselves.

## Domain

The domain is upstream's, ported unchanged in `src/superagent/core/` with its engine tests:

- A **Source** produces immutable **Triggers**; Triggers belong to **Threads**.
- A deterministic **gate** (`policy.ts`) decides who may originate work: a sender on the Source's allowed list who
  addresses the agent makes an explicit request; the admission table and listed bots can make inferred candidates.
- **Eval** turns a batch of Triggers into a **Decision**: accept, attach, stop, ignore or unavailable.
- An accept creates a **Ticket** with an immutable **Mandate**: the Policy version, strength, scope and matched rules.
- **Subscriptions** deliver later messages on a ticket's Threads straight to its worker; a person's follow-up there
  takes no Eval, and only a stop goes back through the gate.
- An **Assignment** binds a ticket to an Executor; replies go out through a **Channel** via a stored **Outbox**.

## What runs where

| Part | Module | Process |
| --- | --- | --- |
| Engine, store, effects queue, outbox | `core/`, `store.ts`, `effects.ts`, `outbox.ts`, `client.ts` | Any Swarm process |
| Host: lock, setup, Source polling, passes, Policy changes, health snapshot | `host.ts`, `setup.ts`, `environment.ts` | `swarm superagent run`, or a TUI with no other host |
| Routing, assessment, follow-up stop check | `assessor.ts`, `prompts.ts` | Host |
| Executor: slots, prepare command, worker processes | `executor.ts` | Host |
| Worker: coding loop on the ticket's session | `worker.ts` | One child process per running ticket |
| Harness turns: Claude Code, Codex, Kimi Code or OpenCode in place of the coding loop | `harness.ts`, `harness-turns.ts` | One child of the worker per turn |
| `swarm harness list\|check`: the harness profiles of this machine | `harness-cli.ts` | CLI |
| Ticket tools (`mcp__ticket__*`) | `ticket-tools.ts` | MCP stdio child of the worker |
| Ticket VMs: slots, leases, the gateway and its model proxy | `vm/vm-work.ts`, `vm/gateway.ts`, `vm/model-proxy.ts` | Host, with `executor.isolation` set to `vm` |
| Guest supervisor: prepares the ticket's directory, starts the worker, renews the lease | `vm/guest.ts`, `vm/gateway-link.ts` | `swarm superagent guest` in a ticket VM |
| Sources | `sources/local.ts`, `sources/github*.ts`, `sources/feishu*.ts` | Host polls; the TUI and CLI write local Triggers |

Engine commands only queue effects, so the TUI and CLI call the Engine directly to file requests, answer, stop and
retry. The outermost store transaction is `BEGIN IMMEDIATE` with a busy timeout, and the effect queue's positions come
from a counter in the database, so several processes share one SQLite file. One host holds `host.lock` and runs the
handlers.

## Differences from upstream

- **No main Session.** Upstream's main DSH Session routed explicit requests, assessed proactive candidates through
  tools, and relayed worker reports. Swarm makes the first two structured model calls (`ModelAssessor`) whose answers
  the host checks and carries out through the same Engine commands; an answer that breaks a limit is asked again once
  with the problem. Relays are rule-based: a worker's `ticket_report` carries `message`, the one short text the person
  reads, which the Engine's reply rules post as the result, the question or the answer. At a milestone a progress
  report may carry one too; the host sends at most one such update every five minutes, none in a ticket's first two.
  When work fails or blocks without a question, the person hears that it stopped and why, in the worker's words or
  the report's summary (`notices.ts`). None of these go to GitHub, whose timeline shows the work.
- **Follow-up stops.** Upstream's main Session heard of each follow-up and could stop work on it. Swarm asks the model
  once per follow-up that reached a ticket whether the person asks to stop; local messages skip this, since the TUI
  and CLI have a stop command.
- **Workers are processes.** A worker process runs a turn and exits once nothing waits for it, so an idle ticket holds
  no process; a delivery wakes it with a new one. A person's message during a turn arrives as a live message at the
  loop's next step. Foreground shell commands move to background processes after 30 seconds
  (`SWARM_SHELL_AUTO_BACKGROUND_MS`), so a long build does not hold back that message; background processes may run
  30 minutes past the turn before they are stopped.
- **Settings are a file.** `~/.swarm/superagent/settings.json` (schema in `settings.ts`) replaces upstream's panel and
  revisioned settings store. The host applies a changed Policy version as upstream's save did: running Evals are
  discarded and live tickets the change bears on receive a policy-changed Input. Team prompt sections can be replaced
  by `~/.swarm/superagent/prompts/{communication,scope,delivery}.md`.
- **Sources.** The local Source is new: each TUI or CLI request starts a Thread, and the operator's OS account is on its
  allowed list by default. GitHub and Feishu stay off until set up. Assessments read the thread window upstream read,
  without further reads; Feishu images are not read yet.
- **No web panel.** The CLI and the TUI's tickets pane and "needs you" strip show what waits for a person.

## Settings

```json
{
  "sources": {
    "github": { "enabled": true, "config": { "repository": "owner/name", "cli": "gh-agent", "observeComments": false } },
    "feishu": { "enabled": false, "config": { "cli": "lark-bot", "chats": [{ "chatId": "oc_...", "listen": "mentions" }] } }
  },
  "policy": { "sources": { "github": { "allowed": [{ "id": "your-login" }] } } },
  "eval": { "mode": "observe" },
  "executor": {
    "maxWorkers": 2,
    "prepare": "git -C ~/src/name worktree add \"$SWARM_TICKET_DIR\" -b \"agent/$SWARM_TICKET_NAME\" origin/main",
    "blockedCommands": ["npm-publish"]
  }
}
```

`cli` names a wrapper signed in as the agent's own GitHub account (or a `lark-cli` configuration in strict mode bot);
setup checks the account, its push access and the bot before the Source polls. Workers get `SWARM_TICKET_*` variables
describing the ticket, the repository and the agent account, and `gh`/`lark-cli` shims that call the wrappers.

## Access

With an `access` block in the settings, each ticket gets a capability when it is accepted, and only some people may
steer it. Without the block, nothing changes: everyone on a list may do everything.

```json
{
  "access": { "limits": { "everyone": { "openTickets": 1, "requestsPerHour": 10 } } },
  "policy": { "sources": { "feishu": {
    "allowed": [{ "id": "ou_..." }],
    "roles": { "ou_owner...": "owner", "ou_guest...": "everyone" },
    "ceilings": { "oc_team...": "local" }
  } } }
}
```

- **Roles.** A sender has the role `roles` gives them. Otherwise someone on `allowed` is a `maintainer`, and anyone else
  is `everyone`. A sender with a role is on the list just as one on `allowed` is.
- **Capability.** A person's explicit request may write to GitHub, as their linked account (below), whatever their role.
  Without a working link, and for work nobody asked for (inferred, or a bot's), it stays `local`: its worker commits in its
  directory, has no `gh` or `lark-cli` account, and its ready result carries the commits as a patch. A receiving scope's
  `ceilings` entry (`read-only`, `local` or `github`) lowers either; chats nobody listed (`other`) are `local` unless a
  ceiling says otherwise.
- **Steering.** A ticket's requester and maintainers steer it. Anyone else's message on its Thread reaches the worker for
  context only (`advisory: true`). It neither resumes nor unblocks the ticket, and it goes to Eval as that person's own
  request. Attaching such a message to the ticket, or a stop from that person, is refused.
- **Limits.** Defaults: `everyone` 1 open ticket and 10 requests an hour, `maintainer` 4 and 60, `owner` 8 and no hourly
  limit. A message beyond them is held back with one answer that says so.

People run these bot commands in Feishu, after mentioning the bot or in a direct message:

| Command | Who | What it does |
|---|---|---|
| `/me` | anyone | Shows your role, open tickets, requests in the last hour, the ceiling here and your GitHub account |
| `/link` | anyone | Links your GitHub account; its code comes in a direct message |
| `/repo [owner/name]` | anyone, in a direct message | Lists or sets your default repository |
| `/unlink` | anyone | Removes your GitHub account |
| `/takeover [ticket]` | the requester or a maintainer (anyone who may write to GitHub, for inferred work) | A new ticket of yours applies a local ticket's patch and opens a pull request; the old ticket ends. It waits until you linked and the ticket has its patch |
| `/role @name owner\|maintainer\|everyone\|none` | owner | Sets the roles of the people mentioned |
| `/listen all\|mentions\|off` | owner, in a group | Lists the chat, or takes it off the list |
| `/ceiling read-only\|local\|github` | owner | Sets how far work asked for in this conversation may write |
| `/chatter [on\|off]` | owner, in a group (anyone, to ask) | Whether the agent joins the conversation here on its own |

People may also ask in their own words: the router runs `/help`, `/me`, `/link`, `/repo` and `/takeover` for someone whose
message asks for what one does, as if they had typed it. The others change settings or remove a link, so only people type
them. The first owner is set in the settings file.

### GitHub accounts

Work that writes to GitHub does so as the person who asked, through a GitHub App they authorize with GitHub's device
flow. Name the app (Device Flow on, expiring user tokens, Contents and Pull requests read and write) in the GitHub
Source's settings: `"app": { "clientId": "Iv23...", "slug": "your-app" }` under `sources.github.config`.

- `/link` sends a code to enter at github.com/login/device, in a direct message even when asked in a group, since
  whoever enters it links their own account to the person who asked. The host keeps the account's tokens, sealed with
  AES-256-GCM under a key from `SWARM_LINK_KEY_FILE`, the service's `link-key` credential (`$CREDENTIALS_DIRECTORY`),
  or `<stateDir>/link-key`. It refreshes them before they expire, and tells the person in the conversation they linked
  from when GitHub refuses a refresh.
- `/repo [owner/name]` lists the repositories where the person installed the app and may push, and sets their default.
  `/unlink` removes the link; GitHub's authorizations page revokes the app itself.
- Someone who asks for a pull request before linking an account gets the work as a local ticket and the code to link.
  Once they linked and the ticket reported ready, the host takes it over and opens the pull request as them.
- A person's explicit request writes to GitHub only once they linked an account. It works on the repository the request
  names (as owner/name or a github.com link), else their default, else the watched repository, else their only one;
  without any, it stays local. The worker's `gh` and git use that person's token, and their commits carry that account's
  identity. A repository other than the watched one is cloned into the ticket's directory, and its
  pull request's link comes back in the result: the host follows review and merge only on the watched repository.
- What a worker does through the app, such as opening a pull request as the person, is the agent's own: the GitHub
  Source does not take it back in as their message.

### Conversation

A message addressed to the agent that asks for no work, such as a greeting, thanks or a question it can answer from the
message alone, gets a short answer in its conversation and starts no ticket.

In a group an owner listed with `/listen all`, `/chatter on` lets the agent join the conversation on its own, reading the
room (読空気): once the chat has been quiet for `lullSeconds`, one model call reads its latest messages, with what the
agent said there, and decides whether a member would say something now. Saying nothing is the usual answer. It posts as
a plain message in the chat, or a reply that quotes the one message it answers, at most `perHour` times an hour, never in
`quiet` hours, and considers a chat at most every `considerMinutes`. `/chatter off`, or listening to mentions only, ends it.

```json
{ "chatter": { "chats": ["oc_..."], "persona": "Who the agent is in conversation", "perHour": 2,
  "lullSeconds": 90, "considerMinutes": 10, "quiet": { "from": 23, "to": 8, "timeZone": "Asia/Shanghai" } } }
```

The persona also shapes its answers to messages addressed to it. Reading every message of a group needs the Feishu app's
`im:message.group_msg` permission.

## Ticket VMs

With `"isolation": "vm"` in `executor`, each ticket's worker runs in a VM of its own instead of as a process of the host's
account. The deployment provides the VMs as systemd units `swarm-ticket@<slot>` that the host's account may start and stop:
each boots a fresh root disk with the ticket's own data disk, and reaches nothing on the host but its slot's gateway on
127.0.0.1 (`executor.vm.port` plus the slot). The host writes the slot's ticket and a new token into `<state>/vm/<slot>`;
the gateway takes that token alone and serves what the mesh's work routes serve a paired node, plus a model proxy that
adds the providers' keys, records usage under the ticket's worker session and refuses calls past a budget with 402. A
guest gets the agent's or its requester's GitHub token only when its ticket works on GitHub as them; a ticket that keeps
its work local gets none. A VM powers off when its worker's turn ends, and the slot that ran a ticket boots it again on a
follow-up, with its disk; the deployment deletes the disk once the ticket ends (`<state>/vm/ended`). Isolation applies
from the host's start; harness tickets need `process`. `executor.vm.slots` (default 4) VMs run at once, and a slot
whose guest stops renewing its lease is treated as work a restart interrupted.

## Safety

Workers run as the operator's OS user in `full-auto` mode, unless they run in ticket VMs; an action that still needs approval is refused and the worker
reports what it needs. A worker on an agent harness runs under the harness's own permission mode or sandbox instead of
Swarm's permission rules ([GUIDE.md, "Harness workers"](GUIDE.md#harness-workers)). The wrappers, blocked commands
and a local ticket's missing accounts are defaults, not a sandbox: a worker can run programs by path and read the
operator's home directory. Messages on a ticket's Threads reach its worker as context whoever wrote
them, so on a public repository strangers can put text in front of a worker with shell access; run the host under a
dedicated OS account holding only the agent's credentials there. Upstream lists which Trigger fields to trust as an
open question; so does this port.

## Verification

`src/superagent/**/*.test.ts` holds the ported upstream specs (engine, stages, policy, store, effects, registry, GitHub and
Feishu reads) and Swarm's own: the client, the assessor against a scripted model, and an end-to-end test that runs a
real host, a worker process and Swarm's coding loop against a local scripted model with no paid calls.
