import React from "react";
import { Box, Text } from "../ui.js";
import { displayWidth, fitToDisplayWidth, padToDisplayWidth } from "../display-width.js";
import { compactValue, policyBadge, resolveTuiColor, sandboxBadge, visualTokenColor, type TuiColorRef } from "../theme.js";
import { ThemedBox } from "./ThemedBox.js";

export type SwarmWorkbenchNavigationItem = {
  id: string;
  label: string;
  shortcut?: string;
  active?: boolean;
};

export type SwarmWorkbenchSessionItem = {
  id: string;
  title: string;
  age?: string;
  status?: string;
  subtitle?: string;
  badge?: string;
  tone?: TuiColorRef;
  attention?: number;
  active?: boolean;
};

export type SwarmWorkbenchToolItem = {
  name: string;
  status?: string;
  tone?: TuiColorRef;
  active?: boolean;
};

export type SwarmWorkbenchWorkerItem = {
  id: string;
  label: string;
  status: string;
  tone?: TuiColorRef;
};

export type SwarmWorkbenchInfoCard = {
  title: string;
  subtitle?: string;
  badge?: string;
  tone?: TuiColorRef;
};

export type SwarmWorkbenchWorkspace = {
  path: string;
  git?: string;
  status?: string;
};

export type SwarmWorkbenchRenderInput = {
  rows: number;
  columns: number;
};

export type SwarmWorkbenchLayoutProps = {
  columns: number;
  rows: number;
  version: string;
  title: string;
  subtitle?: string;
  headerDetail?: string;
  workspace: SwarmWorkbenchWorkspace;
  navigation: SwarmWorkbenchNavigationItem[];
  sessions: SwarmWorkbenchSessionItem[];
  mode: SwarmWorkbenchInfoCard;
  runtime?: SwarmWorkbenchInfoCard;
  permission: SwarmWorkbenchInfoCard;
  sandbox: SwarmWorkbenchInfoCard;
  model: SwarmWorkbenchInfoCard;
  memory: SwarmWorkbenchInfoCard;
  activity?: SwarmWorkbenchInfoCard;
  tools: SwarmWorkbenchToolItem[];
  workers: SwarmWorkbenchWorkerItem[];
  footer: Array<{ key: string; label: string; tone?: TuiColorRef }>;
  centerBottomRows: number;
  renderCenterContent: (input: SwarmWorkbenchRenderInput) => React.ReactNode;
  renderCenterBottom: (input: SwarmWorkbenchRenderInput) => React.ReactNode;
  onNavigate?: (id: string) => void;
  onSelectSession?: (id: string) => void;
};

export type SwarmWorkbenchMetrics = {
  enabled: boolean;
  columns: number;
  rows: number;
  leftColumns: number;
  centerColumns: number;
  rightColumns: number;
  bodyRows: number;
  centerInnerColumns: number;
  centerMainRows: number;
};

const TITLE_ROWS = 1;
const FOOTER_ROWS = 1;
const CENTER_BORDER_ROWS = 2;
const CENTER_HEADER_ROWS = 3;
const CENTER_BORDER_COLUMNS = 2;
const CENTER_PADDING_COLUMNS = 2;
const STATUS_TAG_WIDTH = 8;

export function swarmWorkbenchMetrics(input: {
  columns: number;
  rows: number;
  centerBottomRows?: number;
}): SwarmWorkbenchMetrics {
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(1, Math.floor(input.rows));
  const centerBottomRows = Math.max(1, Math.floor(input.centerBottomRows ?? 4));
  if (columns < 132 || rows < 20) {
    return disabledMetrics(columns, rows);
  }

  const leftColumns = clampDimension(Math.floor(columns * 0.22), 30, 40);
  const rightColumns = clampDimension(Math.floor(columns * 0.23), 34, 44);
  const centerColumns = columns - leftColumns - rightColumns - 2;
  if (centerColumns < 58) {
    return disabledMetrics(columns, rows);
  }

  const bodyRows = Math.max(1, rows - TITLE_ROWS - FOOTER_ROWS);
  const centerInnerColumns = Math.max(20, centerColumns - CENTER_BORDER_COLUMNS - CENTER_PADDING_COLUMNS);
  const centerMainRows = Math.max(
    4,
    bodyRows - CENTER_BORDER_ROWS - CENTER_HEADER_ROWS - centerBottomRows
  );
  return {
    enabled: true,
    columns,
    rows,
    leftColumns,
    centerColumns,
    rightColumns,
    bodyRows,
    centerInnerColumns,
    centerMainRows
  };
}

export function SwarmWorkbenchLayout(props: SwarmWorkbenchLayoutProps): React.ReactElement {
  const metrics = swarmWorkbenchMetrics({
    columns: props.columns,
    rows: props.rows,
    centerBottomRows: props.centerBottomRows
  });
  const centerBottomRows = Math.max(1, props.centerBottomRows);
  if (!metrics.enabled) {
    const compactMainRows = Math.max(4, metrics.bodyRows - centerBottomRows);
    return (
      <Box width={metrics.columns} height={metrics.rows} flexDirection="column" overflow="hidden">
        <WorkbenchTitleBar version={props.version} columns={metrics.columns} />
        <Box width="100%" height={compactMainRows} flexDirection="column" overflow="hidden" paddingX={1}>
          <CenterHeader title={props.title} subtitle={props.subtitle} detail={props.headerDetail} columns={Math.max(20, metrics.columns - 2)} />
          <Box width="100%" flexGrow={1} flexShrink={1} flexDirection="column" overflow="hidden">
            {props.renderCenterContent({
              rows: Math.max(1, compactMainRows - CENTER_HEADER_ROWS),
              columns: Math.max(20, metrics.columns - 2)
            })}
          </Box>
        </Box>
        <Box width="100%" height={centerBottomRows} flexDirection="column" overflow="hidden">
          {props.renderCenterBottom({
            rows: centerBottomRows,
            columns: Math.max(20, metrics.columns - 2)
          })}
        </Box>
        <WorkbenchFooter items={props.footer} columns={metrics.columns} />
      </Box>
    );
  }
  return (
    <Box width={metrics.columns} height={metrics.rows} flexDirection="column" overflow="hidden">
      <WorkbenchTitleBar version={props.version} columns={metrics.columns} />
      <Box flexDirection="row" width="100%" height={metrics.bodyRows} overflow="hidden">
        <LeftSidebar
          width={metrics.leftColumns}
          height={metrics.bodyRows}
          workspace={props.workspace}
          navigation={props.navigation}
          sessions={props.sessions}
          onNavigate={props.onNavigate}
          onSelectSession={props.onSelectSession}
        />
        <Box width={metrics.centerColumns} height={metrics.bodyRows} marginLeft={1} marginRight={1} overflow="hidden">
          <ThemedBox
            width="100%"
            height="100%"
            flexDirection="column"
            borderStyle="single"
            borderColor="surface.line"
            paddingX={1}
            overflow="hidden"
          >
            <CenterHeader title={props.title} subtitle={props.subtitle} detail={props.headerDetail} columns={metrics.centerInnerColumns} />
            <Box width="100%" height={metrics.centerMainRows} flexDirection="column" overflow="hidden">
              {props.renderCenterContent({
                rows: metrics.centerMainRows,
                columns: metrics.centerInnerColumns
              })}
            </Box>
            <Box width="100%" height={centerBottomRows} flexDirection="column" overflow="hidden">
              {props.renderCenterBottom({
                rows: centerBottomRows,
                columns: metrics.centerInnerColumns
              })}
            </Box>
          </ThemedBox>
        </Box>
        <RightRail
          width={metrics.rightColumns}
          height={metrics.bodyRows}
          mode={props.mode}
          runtime={props.runtime}
          permission={props.permission}
          sandbox={props.sandbox}
          model={props.model}
          memory={props.memory}
          activity={props.activity}
          tools={props.tools}
          workers={props.workers}
        />
      </Box>
      <WorkbenchFooter items={props.footer} columns={metrics.columns} />
    </Box>
  );
}

function WorkbenchTitleBar({ version, columns }: { version: string; columns: number }): React.ReactElement {
  const title = `Swarm ${version} • Local Agent Workspace`;
  const leftWidth = 10;
  const titleWidth = displayWidth(title);
  const leftPadding = Math.max(0, Math.floor((columns - titleWidth) / 2) - leftWidth);
  return (
    <Box width="100%" height={TITLE_ROWS} flexDirection="row" overflow="hidden">
      <Text color={visualTokenColor("status.danger")}>●</Text>
      <Text color={visualTokenColor("status.pending")}> ●</Text>
      <Text color={visualTokenColor("status.success")}> ●</Text>
      <Text color={visualTokenColor("brand.focus")}>{" ".repeat(leftPadding)}{title}</Text>
    </Box>
  );
}

function LeftSidebar({
  width,
  height,
  workspace,
  navigation,
  sessions,
  onNavigate,
  onSelectSession
}: {
  width: number;
  height: number;
  workspace: SwarmWorkbenchWorkspace;
  navigation: SwarmWorkbenchNavigationItem[];
  sessions: SwarmWorkbenchSessionItem[];
  onNavigate?: (id: string) => void;
  onSelectSession?: (id: string) => void;
}): React.ReactElement {
  return (
    <ThemedBox
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="single"
      borderColor="surface.line"
      paddingX={1}
      overflow="hidden"
    >
      <Text color={visualTokenColor("brand.focus")} bold>Swarm &gt;_</Text>
      <SidebarSection title="Inbox" width={width} marginTop={1}>
        {navigation.slice(0, 1).map((item) => (
          <NavigationRow key={item.id} item={item} width={width} onNavigate={onNavigate} primary />
        ))}
      </SidebarSection>

      <SidebarSection title="Cases" width={width}>
        {sessions.length ? sessions.slice(0, 6).map((session) => (
          <CaseRow key={session.id} session={session} width={width} onSelect={onSelectSession} />
        )) : <Text color={visualTokenColor("text.muted")}>(none)</Text>}
        <Text color={visualTokenColor("text.muted")}>... View all cases</Text>
      </SidebarSection>

      <SidebarSection title="Workspace" width={width}>
        <Text wrap="truncate">
          <Text color={workspace.path === "no workspace" ? visualTokenColor("status.warning") : visualTokenColor("role.gateway")}>@ </Text>
          <Text color={workspace.path === "no workspace" ? visualTokenColor("status.warning") : visualTokenColor("brand.focus")}>{fitText(workspace.path, width - 6)}</Text>
          {workspace.status ? <Text color={visualTokenColor(workspace.path === "no workspace" ? "status.warning" : "status.success")}> *</Text> : null}
        </Text>
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          {workspace.git ?? "No checkpoint yet"}
        </Text>
      </SidebarSection>

      <SidebarSection title="Navigation" width={width}>
        {navigation.map((item) => (
          <NavigationRow key={item.id} item={item} width={width} onNavigate={onNavigate} />
        ))}
      </SidebarSection>
    </ThemedBox>
  );
}

function CaseRow({ session, width, onSelect }: { session: SwarmWorkbenchSessionItem; width: number; onSelect?: (id: string) => void }): React.ReactElement {
  const titleBudget = Math.max(8, width - 14);
  const titleTone: TuiColorRef = session.active ? "brand.focus" : session.tone ?? "text.primary";
  return (
    <Box flexDirection="column" width="100%">
      <Text
        wrap="truncate"
        focusable={Boolean(onSelect)}
        onClick={onSelect ? (() => onSelect(session.id)) as never : undefined}
      >
        <Text color={session.active ? visualTokenColor("brand.focus") : visualTokenColor("text.muted")}>{session.active ? "> " : "  "}</Text>
        <Text color={resolveTuiColor(titleTone)}>{fitText(session.title || session.id, titleBudget)}</Text>
        {session.age ? <Text color={visualTokenColor("text.muted")}> {session.age}</Text> : null}
      </Text>
      {(session.subtitle || session.badge || session.attention) ? (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          {"  "}
          {session.badge ? <Text color={resolveTuiColor(session.tone ?? "role.gateway")}>{fitText(session.badge, 10)}</Text> : null}
          {session.subtitle ? <Text> {fitText(session.subtitle, Math.max(8, width - 15))}</Text> : null}
          {session.attention ? <Text color={visualTokenColor("status.warning")}> !{session.attention}</Text> : null}
        </Text>
      ) : null}
    </Box>
  );
}

function NavigationRow({
  item,
  width,
  onNavigate,
  primary = false
}: {
  item: SwarmWorkbenchNavigationItem;
  width: number;
  onNavigate?: (id: string) => void;
  primary?: boolean;
}): React.ReactElement {
  const labelBudget = Math.max(8, width - (item.shortcut ? 12 : 6));
  const color = item.active
    ? visualTokenColor("brand.focus")
    : primary
      ? visualTokenColor("brand.focus")
      : visualTokenColor("text.primary");
  return (
    <Text
      wrap="truncate"
      color={color}
      focusable={Boolean(onNavigate)}
      onClick={onNavigate ? (() => onNavigate(item.id)) as never : undefined}
    >
      <Text color={item.active ? visualTokenColor("brand.focus") : visualTokenColor("role.gateway")}>{item.active ? "> " : "  "}</Text>
      {fitText(item.label, labelBudget)}
      {item.shortcut ? <Text color={visualTokenColor("text.muted")}> [{item.shortcut}]</Text> : null}
    </Text>
  );
}

function CenterHeader({ title, subtitle, detail, columns }: { title: string; subtitle?: string; detail?: string; columns: number }): React.ReactElement {
  return (
    <Box width="100%" height={CENTER_HEADER_ROWS} flexDirection="column" overflow="hidden">
      <Text wrap="truncate">
        <Text color={visualTokenColor("brand.focus")} bold># </Text>
        <Text color={visualTokenColor("brand.focus")} bold>{fitText(title, Math.max(12, columns - 2))}</Text>
      </Text>
      <Text color={visualTokenColor("text.muted")} wrap="truncate">
        {subtitle ?? "Ready"}
      </Text>
      <Text color={visualTokenColor("text.muted")} wrap="truncate">
        {detail ?? ""}
      </Text>
    </Box>
  );
}

function RightRail({
  width,
  height,
  mode,
  runtime,
  permission,
  sandbox,
  model,
  memory,
  activity,
  tools,
  workers
}: {
  width: number;
  height: number;
  mode: SwarmWorkbenchInfoCard;
  runtime?: SwarmWorkbenchInfoCard;
  permission: SwarmWorkbenchInfoCard;
  sandbox: SwarmWorkbenchInfoCard;
  model: SwarmWorkbenchInfoCard;
  memory: SwarmWorkbenchInfoCard;
  activity?: SwarmWorkbenchInfoCard;
  tools: SwarmWorkbenchToolItem[];
  workers: SwarmWorkbenchWorkerItem[];
}): React.ReactElement {
  const compact = height < 36;
  const visibleTools = tools.filter((tool) => tool.active);
  return (
    <ThemedBox
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="single"
      borderColor="surface.line"
      paddingX={1}
      overflow="hidden"
    >
      <InfoSection title="Status" card={activity ?? runtime ?? memory} width={width} compact={compact} />
      <InfoSection title="Mode" card={mode} width={width} compact={compact} />
      <InfoSection title="Access" card={permission} width={width} compact={compact} />
      <InfoSection title="Workspace" card={sandbox} width={width} compact={compact} />
      {workers.length ? <WorkerSection workers={workers} width={width} /> : null}
      <InfoSection title="Agent" card={model} width={width} compact={compact} />
      {visibleTools.length ? <ToolSection tools={visibleTools} width={width} compact={compact} /> : null}
    </ThemedBox>
  );
}

function InfoSection({
  title,
  card,
  width,
  progress = false,
  compact = false
}: {
  title: string;
  card: SwarmWorkbenchInfoCard;
  width: number;
  progress?: boolean;
  compact?: boolean;
}): React.ReactElement {
  const tag = card.badge ? fixedTag(card.badge) : "";
  const valueWidth = Math.max(8, width - STATUS_TAG_WIDTH - 8);
  return (
    <SidebarSection title={title} width={width} marginTop={compact ? 0 : 1}>
      <Text wrap="truncate">
        <Text color={resolveTuiColor(card.tone ?? "text.primary")} bold>{fitText(card.title, valueWidth)}</Text>
        {tag ? <Text color={resolveTuiColor(card.tone ?? "status.success")}>  {tag}</Text> : null}
      </Text>
      {card.subtitle ? <Text color={visualTokenColor("text.muted")} wrap="truncate">{card.subtitle}</Text> : null}
      {progress ? (
        <Text color={visualTokenColor("status.success")} wrap="truncate">
          {progressRule(Math.min(18, Math.max(8, width - 8)))}
        </Text>
      ) : null}
    </SidebarSection>
  );
}

function ToolSection({ tools, width, compact = false }: { tools: SwarmWorkbenchToolItem[]; width: number; compact?: boolean }): React.ReactElement {
  return (
    <SidebarSection title="Tools" width={width} marginTop={compact ? 0 : 1}>
      {tools.slice(0, compact ? 4 : 6).map((tool) => (
        <Text key={tool.name} wrap="truncate">
          <Text>{fitText(tool.name, Math.max(8, width - 20))}</Text>
          {tool.status ? <Text color={resolveTuiColor(tool.tone ?? (tool.active ? "status.success" : "text.muted"))}> {fitText(tool.status, 18)}</Text> : null}
        </Text>
      ))}
    </SidebarSection>
  );
}

function WorkerSection({ workers, width }: { workers: SwarmWorkbenchWorkerItem[]; width: number }): React.ReactElement {
  return (
    <SidebarSection title="Active helpers" width={width} marginTop={0}>
      {workers.slice(0, 3).map((worker) => (
        <Text key={worker.id} wrap="truncate">
          <Text color={resolveTuiColor(worker.tone ?? "role.worker")}># </Text>
          <Text>{fitText(worker.label, Math.max(8, width - 16))}</Text>
          <Text color={resolveTuiColor(worker.tone ?? "text.muted")}>  {workerStatusLabel(worker.status)}</Text>
        </Text>
      ))}
    </SidebarSection>
  );
}

function SidebarSection({
  title,
  width,
  children,
  marginTop = 1
}: {
  title: string;
  width: number;
  children: React.ReactNode;
  marginTop?: number;
}): React.ReactElement {
  return (
    <Box width="100%" flexDirection="column" marginTop={marginTop} overflow="hidden">
      <SectionHeader title={title} width={width} />
      {children}
    </Box>
  );
}

function SectionHeader({ title, width }: { title: string; width: number }): React.ReactElement {
  const label = fitText(title, Math.max(4, width - 2));
  return (
    <Text wrap="truncate">
      <Text color={visualTokenColor("brand.focus")} bold>{label}</Text>
      <Text color={visualTokenColor("surface.line")}>{sectionRule(label, width)}</Text>
    </Text>
  );
}

function WorkbenchFooter({
  items,
  columns
}: {
  items: Array<{ key: string; label: string; tone?: TuiColorRef }>;
  columns: number;
}): React.ReactElement {
  const maxItems = columns < 150 ? 6 : items.length;
  return (
    <Box width="100%" height={FOOTER_ROWS} flexDirection="row" overflow="hidden">
      {items.slice(0, maxItems).map((item, index) => (
        <React.Fragment key={`${item.key}:${item.label}`}>
          {index > 0 ? <Text color={visualTokenColor("text.muted")}>   </Text> : null}
          <Text color={resolveTuiColor(item.tone ?? "brand.focus")}>{item.label}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

function disabledMetrics(columns: number, rows: number): SwarmWorkbenchMetrics {
  return {
    enabled: false,
    columns,
    rows,
    leftColumns: 0,
    centerColumns: columns,
    rightColumns: 0,
    bodyRows: Math.max(1, rows - TITLE_ROWS - FOOTER_ROWS),
    centerInnerColumns: Math.max(1, columns - CENTER_BORDER_COLUMNS - CENTER_PADDING_COLUMNS),
    centerMainRows: Math.max(4, rows - TITLE_ROWS - FOOTER_ROWS - CENTER_BORDER_ROWS - CENTER_HEADER_ROWS)
  };
}

function clampDimension(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fitText(value: string, columns: number): string {
  return fitToDisplayWidth(value, Math.max(1, Math.floor(columns)));
}

function sectionRule(title: string, columns: number): string {
  const width = Math.max(0, Math.floor(columns) - displayWidth(title) - 1);
  return width > 0 ? ` ${"-".repeat(width)}` : "";
}

function fixedTag(value: string): string {
  const label = safeTagLabel(value);
  return `[${padToDisplayWidth(fitToDisplayWidth(label, STATUS_TAG_WIDTH, ""), STATUS_TAG_WIDTH)}]`;
}

function safeTagLabel(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[_\s-]+/gu, "-");
  switch (normalized) {
    case "active": return "ACTIVE";
    case "disabled": return "Off";
    case "empty": return "Off";
    case "not-connected": return "Not connected";
    case "completed": return "Done";
    case "complete": return "Done";
    case "success": return "Done";
    case "done": return "Done";
    case "planning": return "Planning";
    case "waiting-attention": return "Waiting";
    case "running": return "Running";
    case "workspace-write": return "RW";
    case "read-only": return "RO";
    case "full-auto": return "Auto";
    case "auto-edit": return "Auto";
    case "ask": return "Ask";
    case "ready": return "READY";
    case "setup": return "SETUP";
    case "risk": return "RISK";
    case "safe": return "SAFE";
    default: return value.length <= STATUS_TAG_WIDTH ? value : compactValue(value, STATUS_TAG_WIDTH);
  }
}

function workerStatusLabel(value: string): string {
  if (value === "completed" || value === "complete" || value === "success") return "Done";
  if (value === "running" || value === "active") return "Running";
  if (value === "pending" || value === "queued") return "Planning";
  return value;
}

function progressRule(width: number): string {
  return `[${"-".repeat(Math.max(1, width - 2))}]`;
}

export function workbenchModeCard(mode: string): SwarmWorkbenchInfoCard {
  if (mode === "full_swarm" || mode === "team") {
    return { title: "Full Swarm", subtitle: "Plans, delegates, then verifies", badge: "Active", tone: "role.swarm" };
  }
  if (mode === "chat" || mode === "ask") {
    return { title: "Chat", subtitle: "Answers without starting a run", badge: "Active", tone: "brand.focus" };
  }
  if (mode === "coding_loop" || mode === "work") {
    return { title: "Plan & Execute", subtitle: "Plans first, then edits safely", badge: "Active", tone: "role.gateway" };
  }
  return { title: "Plan & Execute", subtitle: "Plans first, then edits safely", badge: "Active", tone: "role.gateway" };
}

export function workbenchPolicyCard(permissionMode: string): SwarmWorkbenchInfoCard {
  if (permissionMode === "ask") {
    return { title: "Ask Before Edit", subtitle: "Swarm asks before risky changes", badge: "SAFE", tone: "status.success" };
  }
  if (permissionMode === "yolo") {
    return { title: "YOLO", subtitle: "Edits can run without asking", badge: "RISK", tone: "status.warning" };
  }
  if (permissionMode === "auto-edit") {
    return { title: "Auto Edit", subtitle: "Edits can run after policy checks", badge: "AUTO", tone: "status.pending" };
  }
  if (permissionMode === "full-auto" || permissionMode === "auto") {
    return { title: "Full Auto", subtitle: "Runs with minimal interruption", badge: "AUTO", tone: "status.pending" };
  }
  return { title: policyBadge(permissionMode), subtitle: "Changes follow policy", badge: "POLICY", tone: "status.pending" };
}

export function workbenchSandboxCard(sandboxMode: string): SwarmWorkbenchInfoCard {
  const title = sandboxMode === "read-only"
    ? "Read Only"
    : sandboxMode === "workspace-write"
      ? "Workspace Write"
      : sandboxMode;
  return {
    title,
    subtitle: sandboxMode === "read-only" ? "Can inspect files only" : "Can modify this workspace",
    badge: sandboxBadge(sandboxMode),
    tone: sandboxMode === "read-only" ? "status.pending" : "status.success"
  };
}

export function compactWorkbenchTitle(value: string | undefined, fallback: string): string {
  return compactValue(value?.trim() || fallback, 56);
}
