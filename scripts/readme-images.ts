/**
 * Renders the README's terminal pictures from the real TUI: `npm run docs:images`. SwarmChatApp is driven through two
 * turns by a scripted model (a question, then an edit that waits for approval and finishes), and the tickets view is
 * rendered with sample tickets; each picture is written in English and Chinese to docs/images/. Swarm's state goes to
 * a temporary home, never ~/.swarm. SWARM_README_DEBUG=1 prints each model request's system prompt head.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

const repo = resolve(import.meta.dirname, "..");
const out = join(repo, "docs", "images");
// Resolved: the working directory comes back resolved (/private/var on macOS), and the header shortens it by HOME.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "swarm-readme-")));
// Before Swarm's modules load: they read these when they first need a path.
process.env.SWARM_HOME = join(scratch, "swarm-home");
process.env.SWARM_MESH_HOME = join(scratch, "mesh");
process.env.SWARM_MESH_RELAY = "off";
process.env.HOME = join(scratch, "home");
delete process.env.NO_COLOR;
delete process.env.SWARM_TUI_NO_COLOR;
delete process.env.SWARM_TUI_THEME;

const React = (await import("react")).default;
const { startFakeModel, writeFakeModelHome } = await import("../src/superagent/testing/fake-model.js");
const { SwarmChatApp } = await import("../src/tui/SwarmChatApp.js");
const { TicketsPane } = await import("../src/tui/components/TicketsPane.js");
const { createTuiRoot } = await import("../src/tui/renderer/root.js");
const { renderTuiToFrame } = await import("../src/tui/renderer/testing.js");
const { screenToLines } = await import("../src/tui/renderer/screen.js");
const { screenToSvg } = await import("../src/tui/renderer/frame-svg.js");
const { paneOrder } = await import("../src/tui/tickets/view-model.js");

type Lang = "en" | "zh";
type TicketRow = import("../src/superagent/views.js").TicketRow;

const COLUMNS = 100;
const APPROVAL_ROWS = 19;
// Tall enough that the finished turn keeps the first question on screen; Chinese answers take fewer rows.
const DONE_ROWS: Record<Lang, number> = { en: 27, zh: 22 };
const loop = (fields: Record<string, unknown>): string => JSON.stringify({ files_touched: [], next_actions: [], tool_calls: [], ...fields });

const COPY: Record<Lang, {
  ask: string;
  answer: string;
  change: string;
  done: string;
  review: string;
  verify: string;
  readme: string;
  tickets: TicketRow[];
  ticketsSummary: string;
  alt: { approval: string; done: string; tickets: string };
}> = {
  en: {
    ask: "How do devices pair in this repo?",
    answer: "With a pairing code such as `K7QM-4ZX2`: run `swarm mesh invite` on any device in the swarm, then `swarm mesh join K7QM-4ZX2` on the new one. A code works for 15 minutes, and three wrong tries cancel it.",
    change: "Make pairing codes expire after 10 minutes",
    done: "Pairing codes now expire after 10 minutes. `INVITE_MINUTES` in `src/mesh/pair.ts` was the only place the time was set; invite and join both read it.",
    review: "The change touches only the constant that invite and join read; nothing else assumed 15 minutes.",
    verify: "Checked the invite and join paths read INVITE_MINUTES; no other duration remains.",
    readme: "# Pairing\n\nRun `swarm mesh invite` on any device, then `swarm mesh join <code>` on the new one.\nA code works for 15 minutes; three wrong tries cancel it.\n",
    tickets: [
      ticket({ short: "2c5e81f0", group: "person", label: "Awaiting answer", title: "Retry the flaky upload test", source: "github", question: "Are 3 retries enough?" }),
      ticket({ short: "9a03d4be", group: "person", label: "Awaiting review", title: "Dark theme for the settings page", source: "github", pr: 42, harness: "claude" }),
      ticket({ short: "ovh:5b17e0aa", device: "ovh", group: "working", label: "Working", title: "Translate the onboarding guide", source: "feishu", harness: "codex" }),
      ticket({ short: "e41f7c22", group: "working", label: "Working", title: "Rename the build script to build:all", source: "tui", runsOn: "laptop", pulledBy: "laptop" }),
      ticket({ short: "70bd9e13", group: "ended", label: "Completed", title: "Fix the typo in the install section", source: "github", pr: 41 })
    ],
    ticketsSummary: "2 need you · 2 working",
    alt: {
      approval: "Swarm in a terminal: an earlier question folded to one line, then an edit to src/mesh/pair.ts waiting on a short approval card that shows the diff.",
      done: "Swarm in a terminal: both turns folded to one line each, the answer, and a footer line saying one file changed and one check passed.",
      tickets: "The tickets view: tickets that need you first, then those working on this device and paired ones."
    }
  },
  zh: {
    ask: "这个仓库里设备是怎么配对的？",
    answer: "用一串配对码，比如 `K7QM-4ZX2`：在网格里任一台设备上运行 `swarm mesh invite`，再在新设备上运行 `swarm mesh join K7QM-4ZX2`。码 15 分钟内有效，输错 3 次作废。",
    change: "把配对码的有效期改成 10 分钟",
    done: "配对码现在 10 分钟后失效。时长只在 `src/mesh/pair.ts` 的 `INVITE_MINUTES` 里设置，邀请和加入都读它。",
    review: "改动只涉及邀请和加入共用的常量，没有别处假定 15 分钟。",
    verify: "确认邀请和加入路径都读 INVITE_MINUTES，没有残留的其他时长。",
    readme: "# 配对\n\n在任一设备上运行 `swarm mesh invite`，再在新设备上运行 `swarm mesh join <code>`。\n码 15 分钟内有效，输错 3 次作废。\n",
    tickets: [
      ticket({ short: "2c5e81f0", group: "person", label: "Awaiting answer", title: "上传测试不稳定，加上重试", source: "github", question: "重试 3 次够吗？" }),
      ticket({ short: "9a03d4be", group: "person", label: "Awaiting review", title: "设置页加上深色主题", source: "github", pr: 42, harness: "claude" }),
      ticket({ short: "ovh:5b17e0aa", device: "ovh", group: "working", label: "Working", title: "翻译新手指南", source: "feishu", harness: "codex" }),
      ticket({ short: "e41f7c22", group: "working", label: "Working", title: "把构建脚本改名为 build:all", source: "tui", runsOn: "laptop", pulledBy: "laptop" }),
      ticket({ short: "70bd9e13", group: "ended", label: "Completed", title: "修正安装一节里的错字", source: "github", pr: 41 })
    ],
    ticketsSummary: "2 need you · 2 working",
    alt: {
      approval: "终端里的 Swarm：前一个问题折叠成一行，接着对 src/mesh/pair.ts 的编辑在等一张显示 diff 的简短审批卡片。",
      done: "终端里的 Swarm：两个回合各折叠成一行，下面是回答和一行页脚：改了一个文件，一项检查通过。",
      tickets: "工单视图：需要你的工单排在前面，然后是本机和配对设备上正在进行的工单。"
    }
  }
};

function ticket(fields: Partial<TicketRow> & Pick<TicketRow, "short" | "group" | "label" | "title" | "source">): TicketRow {
  const id = fields.short.replace(/^.*:/u, "").padEnd(32, "0");
  return { id, updatedAt: "2026-11-09T09:00:00.000Z", ...fields };
}

function svg(screen: Parameters<typeof screenToSvg>[0], title: string): string {
  if (process.env.SWARM_README_DEBUG) {
    process.stderr.write(`${screenToLines(screen).join("\n")}\n${"=".repeat(40)}\n`);
  }
  return screenToSvg(screen, { title, fontSize: 14, cellRatio: 0.6, lineHeight: 20, padding: 22, radius: 12 });
}

async function conversation(lang: Lang): Promise<void> {
  const copy = COPY[lang];
  const workspace = join(process.env.HOME!, "projects", "swarm-demo");
  mkdirSync(join(workspace, "src", "mesh"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), copy.readme);
  writeFileSync(join(workspace, "src", "mesh", "pair.ts"), [
    "// How long a pairing code stays open, in minutes.",
    "export const INVITE_MINUTES = 15;",
    "// Wrong tries before a code is cancelled.",
    "export const MAX_TRIES = 3;",
    ""
  ].join("\n"));

  const steps = [
    loop({ status: "continue", summary: "Read the docs and the code", message: "", tool_calls: [
      { id: "r1", action: "Read", inputs: { file_path: "README.md" } },
      { id: "r2", action: "Read", inputs: { file_path: "src/mesh/pair.ts" } }
    ] }),
    loop({ status: "completed", summary: "Answered", message: copy.answer }),
    loop({ status: "continue", summary: "Read the code", message: "", tool_calls: [{ id: "r3", action: "Read", inputs: { file_path: "src/mesh/pair.ts" } }] }),
    loop({ status: "continue", summary: "Change the time", message: "", tool_calls: [{ id: "e1", action: "Edit", inputs: {
      file_path: "src/mesh/pair.ts", old_string: "export const INVITE_MINUTES = 15;", new_string: "export const INVITE_MINUTES = 10;"
    } }] }),
    loop({ status: "completed", summary: "Changed", message: copy.done, files_touched: ["src/mesh/pair.ts"] })
  ];
  let step = 0;
  const model = await startFakeModel((request) => {
    if (process.env.SWARM_README_DEBUG) {
      process.stderr.write(`model: ${request.system.slice(0, 160).replace(/\s+/gu, " ")}\n`);
    }
    if (request.system.includes("execution control-plane router")) {
      const edits = request.user.includes(copy.change);
      return JSON.stringify({ mode: "coding_loop", confidence: 0.9, reason: "workspace", requires_workspace: true, expected_side_effects: edits ? "modify_workspace" : "read_workspace", needs_parallelism: false, parallelism_reason: "", swarm_value: "", risk: "low", fallback_mode: "coding_loop" });
    }
    if (request.system.includes("Convert an internal Swarm review-agent result")) {
      return JSON.stringify({ target_task_id: "coding_loop", reviewer: { agent_id: "reviewer", role: "reviewer" }, verdict: "approve", score: 95, issues: [], summary: copy.review });
    }
    if (request.system.includes("default coding agent")) {
      return steps[Math.min(step++, steps.length - 1)]!;
    }
    // The post-change reviewer and verifier are worker agents; their task names them. The verifier's carries the
    // review's result, so it is matched first.
    if (request.user.includes("Verify the workspace changes")) {
      return loop({ status: "completed", summary: "Verified", message: copy.verify });
    }
    if (request.user.includes("Review the current workspace changes")) {
      return loop({ status: "completed", summary: "Reviewed", message: copy.review });
    }
    return loop({ status: "completed", summary: "ok", message: "ok" });
  });

  const home = process.env.SWARM_HOME!;
  rmSync(home, { recursive: true, force: true });
  writeFakeModelHome(home, model.url);
  nameTheModel(home);
  const previous = process.cwd();
  process.chdir(workspace);
  const stdout = Object.assign(new PassThrough(), { columns: COLUMNS, rows: APPROVAL_ROWS, isTTY: false }) as unknown as NodeJS.WriteStream;
  const root = createTuiRoot({ columns: COLUMNS, rows: APPROVAL_ROWS, stdout, patchConsole: false });
  const text = () => {
    const frame = root.getFrame();
    return frame ? screenToLines(frame.screen).join("\n") : "";
  };
  // Answers wrap, so they are looked for with whitespace collapsed and Markdown backticks gone.
  const shows = (markdown: string) => text().replace(/\s+/gu, " ").includes(markdown.replace(/`/gu, "").replace(/\s+/gu, " ").slice(-24));
  const type = async (value: string) => {
    root.dispatchRawInput(value);
    await sleep(150);
    root.dispatchRawInput("\r");
  };
  try {
    root.render(React.createElement(SwarmChatApp));
    await until(() => text().includes("Ask Swarm"), "the prompt", text);
    await type(copy.ask);
    await until(() => shows(copy.answer) && /▸ Read 2 files/u.test(text()), "the first answer", text);
    await type(copy.change);
    await until(() => text().includes("y yes · a always"), "the approval card", text);
    await sleep(400);
    writeFileSync(join(out, `tui-approval.${lang}.svg`), svg(root.getFrame()!.screen, copy.alt.approval));
    root.dispatchRawInput("y");
    // The finished turn is taller than the card: the terminal grows so the first question stays on screen.
    Object.assign(stdout, { rows: DONE_ROWS[lang] });
    root.resize(COLUMNS, DONE_ROWS[lang]);
    stdout.emit("resize");
    await until(() => shows(copy.done) && text().includes("1 file changed") && text().includes("Ask Swarm"), "the finished edit", text);
    await sleep(800);
    writeFileSync(join(out, `tui-done.${lang}.svg`), svg(root.getFrame()!.screen, copy.alt.done));
  } finally {
    root.unmount();
    await model.close();
    process.chdir(previous);
  }
}

/** The header names the model as a real setup would, not the fake provider's id. */
function nameTheModel(home: string): void {
  const path = join(home, "settings.json");
  const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const provider = { ...settings.providers["local-test"], id: "kimi-coding", name: "Kimi Coding", models: { "kimi-for-coding": { name: "Kimi for Coding" } } };
  delete settings.providers["local-test"];
  settings.providers["kimi-coding"] = provider;
  settings.enabledProviders = ["kimi-coding"];
  settings.models.defaultProvider = "kimi-coding";
  for (const role of ["planner", "worker", "aggregator"]) {
    settings.models[role] = "kimi-coding/kimi-for-coding";
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function tickets(lang: Lang): void {
  const copy = COPY[lang];
  const rows = 11;
  const frame = renderTuiToFrame(React.createElement(TicketsPane, {
    rows: paneOrder(copy.tickets),
    selected: 0,
    columns: COLUMNS,
    height: rows,
    summary: copy.ticketsSummary,
    hosting: true
  }), { columns: COLUMNS, rows });
  writeFileSync(join(out, `tui-tickets.${lang}.svg`), svg(frame.screen, copy.alt.tickets));
}

async function until(predicate: () => boolean, label: string, screen: () => string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}. Screen:\n${screen()}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

mkdirSync(out, { recursive: true });
try {
  for (const lang of ["en", "zh"] as const) {
    await conversation(lang);
    tickets(lang);
  }
  console.log(`wrote ${["tui-approval", "tui-done", "tui-tickets"].flatMap((name) => [`${name}.en.svg`, `${name}.zh.svg`]).join(", ")} to docs/images`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
