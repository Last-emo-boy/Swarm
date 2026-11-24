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
| What the agent runs work on: nodes, harnesses, free workers | `devices.ts` | Host |
| Capability directory: who can do what now, for the main session, the router and workers | `../directory/` | Host writes `host-directory` every minute; any process reads it or builds its own |
| Executor: slots, prepare command, worker processes | `executor.ts` | Host |
| Worker: coding loop on the ticket's session | `worker.ts` | One child process per running ticket |
| Harness turns: Claude Code, Codex, Kimi Code or OpenCode in place of the coding loop | `harness.ts`, `harness-turns.ts` | One child of the worker per turn |
| `swarm harness list\|check`: the harness profiles of this machine | `harness-cli.ts` | CLI |
| Ticket tools (`mcp__ticket__*`) | `ticket-tools.ts` | MCP stdio child of the worker |
| Ticket VMs: slots, leases, the gateway and its model proxy | `vm/vm-work.ts`, `vm/gateway.ts`, `vm/model-proxy.ts` | Host, with `executor.isolation` set to `vm` |
| Cluster ticket VMs: ticket pods, their volumes and egress rules | `vm/kube-control.ts` | Host, with `executor.vm.kube` |
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
  the report's summary (`notices.ts`). A ticket that then waits on that person, or on an answer, reminds them once a day
  later and closes a day after the reminder, with a notice where it asked, which their reply reopens; one whose channel
  can post nothing more is closed the same way without the notice. A request the router could not take in because the
  model timed out is answered once where it was asked, and stays listed in `swarm superagent status` for `again` or
  `dismiss`. None of these go to GitHub, whose timeline shows the work.
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
- **A chat seam.** What the core needs to know about a conversation is one optional part of a Source kind,
  `SourceKind.chat` (`sources/chat.ts`): the platform's name, the agent's identity there, a directory of the kind's chats
  and their people, and constructors for thread keys and channel addresses. Talking paths read a message's fields through
  `metaOf` (`sources/meta.ts`) and build channels through the kind, so nothing outside `sources/` spells a platform's
  names; Feishu is one such kind (`feishu-chat.ts`), and a second chat kind plugs in without touching chatter, memory,
  people, asks, commands or the outbox. `src/testing/fake-chat.ts` is a second kind the tests run the ticket, memory,
  chatter and command paths on. A Source whose API calls all fail no longer reads ready.
- **Sources.** The local Source is new: each TUI or CLI request starts a Thread, and the operator's OS account is on its
  allowed list by default. GitHub and Feishu stay off until set up. Assessments read the thread window upstream read,
  without further reads; Feishu images are not read yet.
- **No web panel.** The CLI and the TUI's tickets pane and "needs you" strip show what waits for a person. The
  terminal also answers why: `swarm superagent why <ticket|message>` reads the store (the message, its routing and the
  router's reason, the ticket's work and reports, the queued messages and whether they went out, the talking paths'
  model calls around it, its usage), and the journal (`journal.ts`) keeps one row per run of chatter, attend, reflection,
  promises and routing with the card sent, the answer when it could not be used, and the outcome and its reason. Rows
  older than 14 days are pruned in the host's pass. Outbox rows record when they went out and the platform's message id.
  `swarm usage --by chat` groups the ledger by the chat or ticket that asked.

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
- **Harness.** Maintainers and owners may ask for the agent harness their work runs on, and the router may choose one
  for their work itself (below), since its turns are paid for by the owner's harness accounts. `everyone`'s work runs on
  the default (`executor.harness`), and the acknowledgement says so when they asked for another.
- **Devices.** Maintainers and owners learn which nodes the agent runs work on and what each runs, and the router may
  name the node their work runs on (below); `everyone` learns how many paired nodes there are, how many are online and
  how many workers are free.

People run these bot commands in Feishu, after mentioning the bot or in a direct message:

| Command | Who | What it does |
|---|---|---|
| `/me` | anyone | Shows your role, open tickets, requests in the last hour, the ceiling here and your GitHub account |
| `/link` | anyone | Links your GitHub account; its code comes in a direct message |
| `/repo [owner/name]` | anyone, in a direct message | Lists or sets your default repository |
| `/unlink` | anyone | Removes your GitHub account |
| `/takeover [ticket]` | the requester or a maintainer (anyone who may write to GitHub, for inferred work) | A new ticket of yours applies a local ticket's patch and opens a pull request; the old ticket ends. It waits until you linked and the ticket has its patch |
| `/devices` | anyone (node names: maintainers and owners) | Shows what the agent runs work on now: this node, its paired nodes and the free workers (below) |
| `/role @name owner\|maintainer\|everyone\|none` | owner | Sets the roles of the people mentioned |
| `/ceiling read-only\|local\|github` | owner | Sets how far work asked for in this conversation may write |
| `/chatter [on\|off]` | owner, in a group (anyone, to ask) | Whether the agent joins the conversation here on its own |
| `/memory [@name] [page]` | anyone (an owner, about someone else) | What the agent remembers about you, numbered, in a direct message |
| `/forget <number>\|all [@name]` | anyone (an owner, about someone else) | Forgets one note about you, by its number in `/memory`, or all of them |

People may also ask in their own words: the router runs `/help`, `/me`, `/link`, `/repo`, `/takeover`, `/devices`, `/memory` and `/forget` for someone whose
message asks for what one does, as if they had typed it. The others change settings or remove a link, so only people type
them. The first owner is set in the settings file.

### Harness choice

A person may name the agent harness their work runs on, such as "用 codex 做" or "run this on Claude Code", in Feishu, on
GitHub or in the TUI. The router's card lists every harness profile of this node's settings with where its work runs:
this node, when its mesh card lists `harness:<id>` (installed and signed in here), else the paired nodes that answered
and list it, else no node. On an accept the router sets `harness` to one of them, the host records it with the request as
`--harness` does, and the ticket's execution takes it; its acknowledgement names the harness and the node. A mesh node
then places the worker on that node, since the work needs `harness:<id>` (`workNeeds`). When no node runs the harness
named, or it is no profile here, the router starts no ticket and answers plainly with chat, naming the harnesses that
can run. A host that is not a mesh node counts a profile as its own only when its own checks found it ready, as the
directory's `this_node` lists it; with `checkHarnesses` on (`swarm superagent run`, the TUI) that means installed and
signed in. Only a router with neither a mesh view nor a directory counts every profile as its own. A signed-out profile
shows as on no node and is refused like any other harness no node runs.

Work that acts as its requester on GitHub (`capability.credential`) runs only on the node that holds their token, so for
it only a harness this node has counts: a harness only a paired node has is answered as unavailable for that request. A
request filed with `--harness` keeps that harness whatever the router says.

The router may also set `harness` without the person naming one, when a choice that runs on a node fits the work
clearly better than the default, such as the only harness signed in on the node that has what the work needs. Its own
choice goes through the same check (`checkedHarness`): only for maintainers' and owners' requests, only a profile some
node runs for this request. The turns spend that harness account's budget, and `usage.budgets.harnesses` still stops
them at its cap.

### Devices and the directory

The router's card carries `directory`, the router's view of the capability directory (`src/directory`), so it
answers "你现在能调用哪些设备？" from real data with chat, in its persona's voice, its acknowledgements do not promise
work now when every worker is busy, and it can choose where work runs. The host hands the router the directory it
writes every minute (`host-directory`) only while that is at most 30 seconds old (`PART_TTL_MS.mesh`), else builds one
from the same pass over the paired nodes and writes it, for every request, whoever sent it. For a requester who may
see nodes (`seesNodes`: without the access model anyone, with it maintainers and owners) it holds:

- `this_node`: this node's name, its machine (OS, `docker`, `gpu`), the harnesses signed in here, its ticket workers
  (`slots`, `running`, `queued`, `free`: the worker processes against `executor.maxWorkers` with `process` isolation,
  or the ticket VM slots here and in the cluster with `vm`), whether it takes work put on it, and why a harness profile
  does not run here. A host that is not a mesh node, or a mesh node whose mesh view could not be read, lists only what
  its own check found running here: no harness when it checks installs alone, never every profile.
- `paired_nodes`: each paired node, online when it answered the card request just now (3 seconds), with its machine,
  harnesses and workers, `takes_work`, the tools it lends by their exact `mcp__<node>__<tool>` names, `may_there` (what
  its grant to this node lets this node ask there: `tickets.submit`, `work.offer`, `lend.shell`, `lend.files.write`,
  `commands.read`), `grant_unknown: true` when that grant is unknown (a node from before grants were on cards, or a
  grant this version cannot read; `may_there` is then empty) and `harness_problems`. One that did not answer shows only
  its name.
- `not_ready`: tool servers, Sources and model providers that are not ready, with why.
- `commands`: the bot commands the router runs, each with what it does.
- `nodes_unknown`, when the paired nodes could not be read, with why.

Anyone else's card holds counts alone: paired nodes, online ones, this node's workers, and the commands. When the
directory cannot be read the card says so and routing goes on.

On an accept the router may set `on` to the node the work runs on: a paired node by its name or id, or `here`. It is
for the requesters who see nodes, when the person asks for a node or one node clearly fits the work. The host checks
it against the directory (`placementProblem`): the node answered, takes work, has `work.offer` in `may_there` or
`grant_unknown` (the offer then tries it, and that node's grant decides), and has what `needs` lists and the harness
the ticket runs on (the one chosen, the one filed, else `executor.harness`). A paired node is also dropped when the
directory the router read was written over 30 seconds before (`PART_TTL_MS.mesh`), and when the host's live mesh
view, read after the model answered, does not list it as answering (`<node> does not answer now`); a view that cannot
be read leaves the directory's word. Work that acts as its requester on GitHub stays on this node. A node that passes
is written with the ticket's placement as `updatePlacement(ticket, { on })`, the field `swarm superagent request --on`
and `place` write, so the placement offers the work there under a `work.offer` lease. A node that fails is dropped,
never the accept: the journal's route row starts with `on <node> dropped: <why>` (`swarm superagent why`), and the
work is placed as usual.

`/devices` prints what the agent runs work on from the same pass over the paired nodes. A ticket's worker reads the
host's directory with its `directory` tool, wherever it runs (in a ticket VM or on a paired node the owner runs the
tool), node names only for a requester who sees them; its `devices` tool still answers the shorter list as before.
Workers do not file tickets on other nodes: work beyond their ticket goes back to the router with `handback`.

The main session reads the same directory and files work through `Dispatch`, as the terminal's operator, the actor
`swarm superagent request` files as, so the host sets the ticket's mandate from that role as for any request. Those
tools, and the commands the directory lists as a person's alone (pairing, grants, lending, placement, pausing,
settings, sign-ins), are in [GUIDE.md](GUIDE.md#who-can-do-what-the-directory).

A ticket VM is no mesh node: its own `swarm mesh` shows only itself. A worker uses what paired nodes lend (`swarm mesh
lend`) with its `mesh` tool, which its host runs over the host's own links: without arguments it lists each paired node
and what it lends, and with a node, a tool (`shell`, `list_files`, `read_file`, `write_file`) and its arguments it calls
it there. A command stops after at most 100 seconds, within the time a ticket tool may take. Every ticket's worker has it;
under the access model, a worker whose requester is below maintainer learns only how many paired nodes there are and
reaches none of them. Every call is kept with its ticket (`mesh-calls:<ticket>`). A read-only ticket's worker
may only `list_files` and `read_file` there: the host refuses the other lent tools before they reach the node, since
harnesses run their MCP servers outside their own read-only turns. A shell runs as the user its node lends as, with
that user's credentials, such as a kubeconfig.

Swarm's own worker reaches paired nodes only through its `mesh` tool, on any host, a mesh node included: it never
loads the MCP servers paired nodes lend. `workerRuntime` (`worker.ts`) builds its `SwarmRuntime` with
`borrowMesh: false`, which drops only the lent servers and keeps the workspace `.mcp.json` and plugin servers (a
`strict` runtime MCP config still drops all of them). `createCapabilityPlane` takes the same option. The main session
still borrows them as `mcp__<peer>__<tool>`.

### GitHub accounts

Work that writes to GitHub does so as the person who asked, through a GitHub App they authorize with GitHub's device
flow. Name the app (Device Flow on, expiring user tokens, Contents and Pull requests read and write) in the GitHub
Source's settings: `"app": { "clientId": "Iv23...", "slug": "your-app" }` under `sources.github.config`.

- `/link` sends a code to enter at github.com/login/device, in a direct message even when asked in a group, since
  whoever enters it links their own account to the person who asked. The host keeps the account's tokens, sealed with
  AES-256-GCM under a key from `SWARM_LINK_KEY_FILE`, the service's `link-key` credential (`$CREDENTIALS_DIRECTORY`),
  or `<stateDir>/link-key`. It refreshes them before they expire, and tells the person in the conversation they linked
  from when GitHub refuses a refresh. A link, and the mandate of a ticket asked for on GitHub, carry the account's number
  as well as its login: work runs as the person only when the number matches, so a login that was freed and registered by
  someone else never receives the old holder's token or steering rights. A link made before numbers were kept still
  matches by login until that person links again.
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

The agent knows who is who on Feishu. The Feishu Source reads the member lists of the chats it is in, a few each minute
and each again every six hours (sooner when a stranger writes there), and every message takes in the names it mentions.
The router's card then names the sender, the chat, the people the message mentions and who is in the chat. It also shows
the conversation the message is part of: the topic's latest messages for a message in a topic, else the chat's, with other
bots and the agent's own words, which the outbox records from everything it posts. A worker reads the same records with
the `people` tool and `chat/<chat-id>`: the latest messages of a group the agent is in, or of its ticket's own chat, but
never someone else's direct messages. None of these ask Feishu at the time, so naming someone never waits on it.

A worker reads the files and images people attach on Feishu with the `attachment` tool, for a message its ticket can read:
the message's attachments, or one of them, which the host downloads with the bot's CLI (at most 20 MB) and reads. The
worker gets its text where the host can extract it (plain text, Markdown, JSON, CSV, HTML, .docx, and PDF where
`pdftotext` is installed), and its tools save the file into its directory under `.swarm-attachments/`, which git ignores,
wherever the worker runs. The download needs the Feishu app's permission to read message resources (`im:message:readonly`).

Anyone may have the agent message someone else: "帮我私聊小王说…" or "去群里@一下大家". The router's `message` kind
sends a direct message to a person, by id or by the name the requester used, or posts into a group it is in, and can tell
the requester it did. A name that fits several people is asked about. A worker's `message` tool does the same for its
ticket, at most ten times an hour. Chat answers, messages and the agent's own remarks can @ people for real: the text names
them as `@name`, and the Feishu sender turns each into a mention (`all` for everyone, only when asked).

Files and images ride on the message that carries them: a ticket's worker lists them, downloads one with the bot's CLI and
reads its text (plain text, Markdown, JSON, CSV, HTML, .docx, PDF) — so a request about a file does not depend on the @ being
on the file's own message, and a reply that carries no file shows the ones on the message it answers. Every chat card also
carries `media_excerpt`: what the host read of the attachment on each message with media, kept for 14 days and at most 500
reads, so the chatter and the router speak about a file from its text rather than from a placeholder.

`/chatter on` in a group lets the agent join the conversation there on its own, reading the room (読空気). With
`everywhere`, it does so in every group it is in, except those an owner turned off with `/chatter off`. Once a chat has
been quiet for `lullSeconds`, one model call reads its latest messages, with what the agent said there, and decides
whether a member would say something now. Saying nothing is the usual answer. It posts as a plain message in the chat, or
a reply that quotes the one message it answers and may @ its writer. It speaks on its own at most `perHour` times an hour
(answers it was asked for do not count), never in `quiet` hours, and considers a chat at most every `considerMinutes`.
It reads the chat from the messages it keeps. The Feishu Source hears every group the bot is in (`otherChats` is `mentions` by
default): it keeps every message, answers when someone @s it, and fills in from each group's history what the live stream
missed. `otherChats: "all"` reads every message there, so a file someone posts without an @ is fetched too; with the
admission table's `listedUnaddressed`/`unlistedUnaddressed` set to `explicit`, such a message is also taken as the request it
plainly is, rather than only a candidate. `otherChats: "none"` limits it to the groups in `chats`.

```json
{ "chatter": { "everywhere": true, "off": ["oc_..."], "chats": ["oc_..."], "persona": "Who the agent is in conversation",
  "perHour": 2, "lullSeconds": 90, "considerMinutes": 10, "quiet": { "from": 23, "to": 8, "timeZone": "Asia/Shanghai" } } }
```

In those groups it also attends, within about 15 seconds, to what calls for it there but its router does not answer:
another bot that @s it, someone who replies to one of its messages, or who names it without an @ (as a word, so a link
such as `w33d.xyz` does not). One model call reads the chat and answers when a member would, as often as it is called:
there is no limit per hour. It always answers what is put to it directly, a question, a request for its progress, a task
or a contest it is called into, if only to say it has nothing to report or cannot take it on; a bot's message that only
acknowledges or thanks gets no answer, and in quiet hours, where an owner set them, it answers no bot. A reply too long
for the chat is written again, then cut after a whole sentence. A bot's message never starts work: it is answered, not
acted on. Each message that calls for it gets its own answer: two people naming it inside one window hear from it twice,
one message apiece, and a message it leaves out is read again at the next settle rather than swallowed. In the same
answer it may keep what it learned as a note, under the rule the router's notes follow.

When the router messages someone on a person's behalf and they want to hear back (`await_answer`, such as "去问问他们进度"),
the agent waits up to 12 hours for the answer: in the group, a message to it (an @, a reply to its message or its name)
from the people it @-ed, or in the person's direct messages; a person or another bot may write it. It then tells the
person who asked, quoting their message and @-ing them, and stops waiting. When the one it asked wants something back
that only the person it asks for can give, such as an account name, it asks that person the same way, and takes their
answer back.

The persona also shapes its answers to messages addressed to it. Reading every message of a group needs the Feishu app's
`im:message.group_msg` permission.

### Memory

With `memory.enabled`, the agent remembers people, chats and itself across conversations and tickets, as a person would.
Its notes are short, one thing each, about one subject, and record where it learned them: facts, preferences, events,
and promises, which have a due time.

- **Writing.** Once a chat (a group or a direct message) has gone quiet for `lullSeconds` with at least `minMessages` new
  messages, or one addressed to the agent, and at most every `reflectMinutes`, one model call reads what was said and
  changes the notes about the people who spoke, the chat and itself. A ticket that ends gets the same about its requester.
  The router also keeps what a message addressed to it tells that will matter later, judged by what it means, with or
  without words such as 记住: a preference ("以后别在群里刷屏"), a plan, or a promise ("明天十点提醒我…"), kept with its answer
  so that an answer to a request to remember can say so. Workers keep notes with the `remember` tool and look them up with
  `recall`.
- **Reading.** The router, chatter and each ticket's worker get the notes about whoever and wherever they talk: the sender,
  the people mentioned, the chat and the agent itself. Notes are used everywhere, like one person's memory; the prompts ask
  for tact about what was said in private, and never to keep secrets or keys.
- **Acting on it.** When a promise falls due, the agent writes the message itself and posts it where it was made, with an @,
  or in the person's direct messages. A promise moved to a later time while kept falls due again then; one whose message
  cannot be written or posted yet keeps its backoff and stays due. A model answer that comes back empty leaves it due for
  one more pass, and a second empty answer sends a fixed message quoting the promise instead of closing it unsaid. A
  reach-out too long for a chat is cut to fit rather than withheld. After a conversation it may also write to someone on
  its own, at most `dmPerDay` times a day, once a day per person, and never in chatter's quiet hours.
- **Upkeep.** A subject with more than `perSubject` notes is tidied by the model into about half.
- **Control.** `/memory` shows anyone what it remembers about them, and `/forget` erases it; owners can name anyone.

Every model call here runs as an effect in the background: `superagent_memory` reflects and tidies, and
`superagent_promise` keeps promises.

```json
{ "memory": { "enabled": true, "lullSeconds": 300, "reflectMinutes": 30, "minMessages": 4, "perSubject": 40, "dmPerDay": 3 } }
```

### Effects, retries and what spends money

Talking paths run as effects in a durable queue. A parse failure has its own cap in the path that asked; a call that
keeps throwing for another reason is tried about five times over roughly an hour, with backoff, and then left quiet with
a give-up row in the journal (`swarm superagent why` shows it) rather than billing one full call a minute through an
outage. Web searches are billed and now recorded in the usage ledger like any prose call, so `assertBudget` and
`swarm usage` count them; a provider that reports only zeros records no row.

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
from the host's start. A VM runs Swarm's coding loop, or OpenCode for a ticket on an OpenCode profile: the image has
OpenCode, and the guest points it at the gateway too, with Swarm's chat-completions providers as its providers, the slot's
token as their key and the worker's model as its model (bring your own key: the host's key, which never enters the VM).
The model proxy relays OpenCode's streamed chat completions and counts the usage of their last event. Under ticket VMs a
mesh node lists `harness:<id>` for its OpenCode profiles, not for the harnesses installed on it; other harnesses run on
paired nodes that have them, or with `process`. `executor.vm.slots` (default 4) VMs run at once, and a slot
whose guest stops renewing its lease is treated as work a restart interrupted.

With `executor.vm.kube`, tickets that find the host's slots full boot in pods of a Kubernetes cluster that the deployment
set up: a namespace (`namespace`, default `swarm-tickets`), a device plugin that gives pods `/dev/kvm` as the resource
`swarm.w33d.xyz/kvm`, a tunnel pod, and network policies that let a ticket pod reach DNS, the internet and its own slot's
tunnel port, and no private range, node or other pod. Each of the cluster's `slots` (default 10) runs QEMU in a pod of the
runner image (`image`), with the same VM image, `cpu` and `memoryMiB` for its guest, and the ticket's data disk on a volume
of its own (`diskGiB` plus room for the filesystem), which is deleted once the ticket ends. The host reaches the cluster
with `kubeconfig` (empty: its service's `kubeconfig` credential) and only creates and deletes ticket pods, their token
Secrets and volumes; the deployment forwards each cluster slot's tunnel port to the host's gateway for it, on 127.0.0.1 at
`port` (default 47200) plus the slot. A ticket keeps to the side its disk is on, so a follow-up waits for the cluster's
slots even when the host's are free. With `executor.vm.slots` set to 0, every ticket runs in the cluster. Ticket pods tolerate
the taint `swarm.w33d.xyz/tickets`, so a node pool kept for them, apart from the nodes the cluster's own pods run on, can
have no nodes while no ticket runs. A cluster VM starts in the background: the launch returns once the slot holds the
ticket, and the host applies the volume and pod, waits for the pod's node (which the cluster may add first), and only then
creates the pod's token Secret, after the nodes' public addresses are in the egress policy's except list, so nothing in
the pod runs before its node is out of its reach. A start that fails ends the boot's lease after 30 seconds per boot so
far, and the ticket launches again, failing after three boots with the error. A boot holds its lease for 15 minutes;
while cluster VMs run, the host keeps the except list current every 15 seconds.

## The journal

Every model call the host makes on its own behalf is one row in the `journal` table of the store: the agent's
considerations and attends, a reflection on a chat or a ticket, a promise's message, a tidy, and the router's routing
and assessment calls. A row holds the purpose and what the call was about (the chat, message, ticket, note or subject),
the card exactly as sent, and as the call returns, its outcome: `sent`, `silent` or `dropped` with the model's reason,
`skipped` when no call was made, `failed` with the error, `answered`, `attached`, or the router's decision kind. A retry
is its own row; a run that left one open is marked `dropped` with reason `retried` when the next starts. `why` joins
these rows to the trigger, its disposition and decision, the ticket and its reports, the outbox rows and the usage
ledger, so a person can see what the agent heard, what it thought it was doing, and what it did.

The journal is additive: nothing it records changes what the agent says or does. It stays in the state directory with
the rest of the store, is pruned after 14 days, and holds people's messages, so it is never copied into the repository.

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
real host, a worker process and Swarm's coding loop against a local scripted model with no paid calls. Tests never reach
the real `lark-cli` or `gh`: `src/testing/env.ts` puts stub `lark-cli`, `lark-bot` and `gh` first on `PATH`, which refuse
with exit code 97, and points `LARKSUITE_CLI_CONFIG_DIR` at an empty temporary directory.
