# Chat adapters

A chat adapter brings a second platform into the superagent beside Feishu: Slack, Discord, a company IM. This is what
one is, what it must provide, and how to know it works. The core does not change to take one on.

## What an adapter is

One `SourceKind` (`src/superagent/sources/kind.ts`) registered in `SuperagentClient`'s kind list, with a `chat: ChatKind`
(`sources/chat.ts`) beside it. Feishu is one (`sources/feishu.ts`); the fake kind in `testing/fake-chat.ts` is another,
with no platform behind it. Everything the core does with a chat — routing, memory, chatter, bot commands, replies, the
outbox's record of what the agent said, attachments — it does through these two objects. `src/superagent/core` has no
platform in it and takes no change for a new adapter.

## What to provide

In reading order; the first files to copy from are Feishu's and the fake kind's side by side.

1. **`kind`, `title`.** `kind` is the Source id (every trigger, channel and directory entry carries it) and the word
   settings and policies use. `enabledByDefault` decides whether a fresh install runs it.
2. **`schema`.** A strict zod object; defaults fill what a new install needs. `registry.resolve` validates stored
   configuration against it, and every hook that reads it gets the validated value: `channel.send`/`allowed` as
   `host.config`, `check.verify` and `chat.agent`/`chat.probe` as their last argument, `files.read`/`readResource` and
   `scope` likewise, and `watch` through `ctx.config(<kind>)`.
3. **`scope`.** For one message `meta`: whether it was listened to, whether only observed, and which policy row applies
   (or the reason it was not). The gate decides who may originate work from this.
4. **`channel`.** `allowed(address, config)` — may a reply still go to this address (the Outbox calls it before every
   delivery); `send(host, message)` — deliver idempotently by `message.id`, `'gone'` when the conversation can never
   take it, throw when the failure may pass; `host.config` is the kind's validated configuration, resolved at delivery
   time. `link(address, links)` — the page a person can open. Two obligations: be idempotent by `message.id`, and call
   `host.posted({ messageId, chatId })` with the id the platform gave the message — a reply to it is then a reply to the
   agent (people.ts, `posted`).
5. **`chat`.** `platform` (the word prompts and cards say), `agent(deployment, config)` (the bot's id, display name and
   every id it may appear as — from the deployment when the account resolved there, otherwise from `config`, as a Slack
   bot user id would be), `directory` (chats, people, by-name lookup, and which ids are this kind's people and chats),
   `thread`/`chat`/`user`/`update` (the channel constructors; the core never spells a platform's address itself),
   `describe(channel)` (what a stored address points at), and `probe(commands, deployment, config)` — one authenticated
   call, throwing the platform's message when the API is unreachable. `probe` is required: a kind whose watch loop claims
   `ready` must say how to tell that the claim is stale, and the acceptance suite asserts the sign-in check asked it.
6. **`policy`.** The kind's part of the policy: `allowed` ids, `explicit` wording, `schema`, and optional `sync`/`rows`.
7. **`health` and `check`.** `health` lists every health entry the kind owns; names are global, and one another part
   owns is refused at registration. `check: { entry, verify(commands, deployment, config) }` is the account sign-in
   test: `entry` must be one of the declared names, `verify` makes one cheap call and either resolves with a short
   ready detail or throws the failure text. The host runs it at most every five minutes; the registry writes `ready`
   or `error` on the entry. Keep the watch loop's own entries separate — `feishu` and `history` are the loop's,
   `feishu-login` the check's, and each writes only its own.
8. **`files`** (optional). `prefix` — the word ticket `read` resources are addressed under (`feishu/<trigger>/thread`);
   `attachments(trigger)` — the files and images the message names; `read(commands, trigger, ref, config)` — one
   downloaded and read (text where extractable, bytes within the host's inline limit); `readResource(commands, trigger,
   resource, config)` — a ticket's `read` of that prefix. The prefix may not be `github`: ticket `read` sends every
   `github/` resource to the repository API before asking a kind, and the registry refuses the word at registration. A
   kind without `files` says so through the attachment tool (`"<platform> messages have no attachments this worker can
   read"`), and nothing is routed to it.
9. **`watch`** (optional for a kind that receives messages another way). The polling loop, run by the host while the
   instance is on; it stores Triggers through the Engine and returns when `signal` aborts. A kind without one is not
   "Off": the host writes `paused`/`Off` only for a Source switched off, so a check-only kind's health entry keeps
   whatever its `check` wrote. Today this is poll-only: a public webhook listener, its request verification, port and
   bind config wait for the platform's choice.
10. **`environment`** (optional). The variables and values ticket workers get, declared so `swarm` can list them.
11. **`threadContext`** (optional). The reader an assessor uses for a message's surrounding messages, when the kind has
    a platform-side read for it.

Then the settings shape: `sources.<kind>: { enabled, config }` and `policy.sources.<kind>` are validated against what the
kind declared. Account resolution (`resolveFeishuBot`, `SETUP_FIELDS`, `Deployment.feishu`) is still Feishu's; a new
platform needs the same seam built, or the deployment supplied some other way.

## Definition of done

`chatAcceptance('<yourkind>', fixture)` in `testing/chat-acceptance.ts` passes, in a `*.test.ts` of the adapter's own. It
runs nine cases, each against a fresh state directory and a `SuperagentClient` with only the kind under test on, and
drives nothing but the contract. The fixture also reports `probed()` (how often the platform was asked whether it
answers) and `refused()` (settings under which the kind refuses an address its own settings accept), and may supply
`signOut(message)` to make the platform refuse:

1. **Ticket start and answer** — a message a person sent becomes a candidate, an accept creates a ticket whose channel is
   on the kind's own thread for that chat, and the acknowledgement is delivered through the kind.
2. **Memory keep and recall** — a finished ticket's reflection writes a note about the kind's own person subject, and
   the notes card shows it (another kind's person with the same raw id does not see it).
3. **Chatter post** — a lull in the chat makes the agent post through the kind, and the outbox records its line.
4. **Command answer** — `/me` from the kind is answered in the conversation it came from.
5. **Own-message record** — the platform id the kind reported through `host.posted` is kept as the agent's own message,
   so a reply to it answers the agent.
6. **Health** — `sources.check` writes `ready` into the check entry the kind declared, and the check asked the
   platform to get there (`probed()` moved); with `signOut`, the same check reads `error` with the platform's message.
7. **Attachments** — a kind without `files` refuses by its platform name; a kind with `files` lists a message's
   attachments and reads one back whole.
8. **Delivery gate** — a reply into an address the kind accepts is `sent`; the address `refused()` names is refused by
   `allowed` under the refusing settings, and a receipt dropped for that reason reads `channelIgnored`.
9. **Link** — `sources.link` gives a non-empty url whose label names the kind's platform.

Feishu and the fake kind pass the same suite (`testing/chat-acceptance.test.ts`); the fake kind is the reference for a
kind the core itself registers, Feishu for one behind a real CLI.

## What stays the platform's

Correct for a new adapter to do differently, and correctly out of the core:

- **CLI invocation shapes and message rendering.** `feishu-channel.ts` (lark-cli flags, `--markdown` vs `--text`,
  mention expansion), `feishu-attachment.ts` (the tag and markdown regexes that read a rendered message).
- **Resource grammar.** `feishuRead`'s `feishu/<trigger>/<section>` shape is Feishu's; a new adapter picks its own under
  its own `prefix` (not `github`, which ticket `read` already routes).
- **Account resolution and setup.** `resolveFeishuBot`, `SETUP_FIELDS`, `Deployment.feishu`, `/link` codes.
- **Error codes and their meaning.** Feishu's `230011` (withdrawn) and `230013` (unavailable) settle a delivery as
  `gone`; another platform decides what its own refusals mean.
- **Wording.** `<at>` tags, `cliText` `@` escaping, the brand-dependent Chinese/English `say`.
- **Environment names.** `SWARM_TICKET_FEISHU_*` are Feishu's.
- **People, roles and GitHub links.** They are per source by design: a role granted on Feishu is not a role on another
  platform, and notes are keyed by qualified subject. Only the agent's own notes carry over.

## Not decided

- A public listener: request verification, port, bind, and the host's exposure of it.
- Identity mapping between kinds: whether a person on one platform is the same person as one on another. Until then
  they are two people.

## One rule to remember

Chat ids are unique among installed kinds. The chatter's per-chat state, the outbox's record of what the agent said and
memory's reflection marks are keyed by chat id alone (`kv.ts`), so two kinds sharing one id share them. Pick ids that
cannot collide with another kind's.

## Review checklist

- Health names unique across all kinds; the check's entry is its own, never the watch loop's.
- `send` idempotent by `message.id`, and `'gone'` only for a conversation that will never take the message.
- `allowed` says the same thing `scope` does about who and where; the acceptance suite checks both answers.
- `host.posted` called with the platform's id on every delivery that has one.
- `check.verify` one cheap call, never a poll.
- `files` either complete (attachment listing, read, resource) or absent — not half.
- Every constructor it hands out carries its own `source`.
