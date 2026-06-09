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
  const centerHeaderRows = visibleCenterHeaderRows(props.subtitle, props.headerDetail);
  const footerRows = visibleWorkbenchFooterRows(props.footer, metrics.columns);
  const bodyRows = metrics.bodyRows + (FOOTER_ROWS - footerRows);
  if (!metrics.enabled) {
    const compactMainRows = Math.max(4, bodyRows - centerBottomRows);
    const compactContentRows = Math.max(1, compactMainRows - centerHeaderRows);
    return (
      <Box width={metrics.columns} height={metrics.rows} flexDirection="column" overflow="hidden">
        <WorkbenchTitleBar columns={metrics.columns} />
        <Box width="100%" height={compactMainRows} flexDirection="column" overflow="hidden" paddingX={1}>
          <CenterHeader title={props.title} subtitle={props.subtitle} detail={props.headerDetail} columns={Math.max(20, metrics.columns - 2)} />
          <Box width="100%" flexGrow={1} flexShrink={1} flexDirection="column" overflow="hidden">
            {props.renderCenterContent({
              rows: compactContentRows,
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
        {footerRows ? <WorkbenchFooter items={props.footer} columns={metrics.columns} /> : null}
      </Box>
    );
  }
  const showRightRail = hasVisibleRightRailContent({
    mode: props.mode,
    runtime: props.runtime,
    permission: props.permission,
    sandbox: props.sandbox,
    model: props.model,
    memory: props.memory,
    activity: props.activity,
    tools: props.tools,
    workers: props.workers
  });
  const centerColumns = showRightRail ? metrics.centerColumns : metrics.centerColumns + metrics.rightColumns + 1;
  const centerInnerColumns = Math.max(20, centerColumns - CENTER_BORDER_COLUMNS - CENTER_PADDING_COLUMNS);
  const centerMainRows = Math.max(4, bodyRows - CENTER_BORDER_ROWS - centerHeaderRows - centerBottomRows);
  return (
    <Box width={metrics.columns} height={metrics.rows} flexDirection="column" overflow="hidden">
      <WorkbenchTitleBar columns={metrics.columns} />
      <Box flexDirection="row" width="100%" height={bodyRows} overflow="hidden">
        <LeftSidebar
          width={metrics.leftColumns}
          height={bodyRows}
          workspace={props.workspace}
          navigation={props.navigation}
          sessions={props.sessions}
          onNavigate={props.onNavigate}
          onSelectSession={props.onSelectSession}
        />
        <Box width={centerColumns} height={bodyRows} marginLeft={1} marginRight={showRightRail ? 1 : 0} overflow="hidden">
          <ThemedBox
            width="100%"
            height="100%"
            flexDirection="column"
            borderStyle="single"
            borderColor="surface.line"
            paddingX={1}
            overflow="hidden"
          >
            <CenterHeader title={props.title} subtitle={props.subtitle} detail={props.headerDetail} columns={centerInnerColumns} />
            <Box width="100%" height={centerMainRows} flexDirection="column" overflow="hidden">
              {props.renderCenterContent({
                rows: centerMainRows,
                columns: centerInnerColumns
              })}
            </Box>
            <Box width="100%" height={centerBottomRows} flexDirection="column" overflow="hidden">
              {props.renderCenterBottom({
                rows: centerBottomRows,
                columns: centerInnerColumns
              })}
            </Box>
          </ThemedBox>
        </Box>
        {showRightRail ? (
          <RightRail
            width={metrics.rightColumns}
            height={bodyRows}
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
        ) : null}
      </Box>
      {footerRows ? <WorkbenchFooter items={props.footer} columns={metrics.columns} /> : null}
    </Box>
  );
}

function WorkbenchTitleBar({ columns }: { columns: number }): React.ReactElement {
  const title = "Swarm";
  const titleWidth = displayWidth(title);
  const leftPadding = Math.max(0, Math.floor((columns - titleWidth) / 2));
  return (
    <Box width="100%" height={TITLE_ROWS} flexDirection="row" overflow="hidden">
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
  const workspaceMeta = visibleWorkspaceMeta(workspace.git);
  const showWorkspace = isVisibleWorkspaceSection(workspace, workspaceMeta);
  const primaryNavigation = navigation.slice(0, 1);
  const secondaryNavigation = navigation.slice(1).filter(isVisibleWorkbenchNavigationItem);
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
      <NavigationList items={primaryNavigation} width={width} onNavigate={onNavigate} primary marginTop={0} />

      {sessions.length ? (
        <CaseList sessions={sessions} width={width} onSelectSession={onSelectSession} />
      ) : null}

      {showWorkspace ? (
        <SidebarSection title="Workspace" width={width}>
          <Text wrap="truncate">
            <Text color={workspace.path === "no workspace" ? visualTokenColor("status.warning") : visualTokenColor("role.gateway")}>@ </Text>
            <Text color={workspace.path === "no workspace" ? visualTokenColor("status.warning") : visualTokenColor("brand.focus")}>{fitText(workspace.path, width - 6)}</Text>
            {workspace.status ? <Text color={visualTokenColor(workspace.path === "no workspace" ? "status.warning" : "status.success")}> *</Text> : null}
          </Text>
          {workspaceMeta ? (
            <Text color={visualTokenColor("text.muted")} wrap="truncate">
              {workspaceMeta}
            </Text>
          ) : null}
        </SidebarSection>
      ) : null}

      {secondaryNavigation.length ? (
        <NavigationList items={secondaryNavigation} width={width} onNavigate={onNavigate} />
      ) : null}
    </ThemedBox>
  );
}

function visibleWorkspaceMeta(value: string | undefined): string | undefined {
  const meta = value?.trim();
  if (!meta) {
    return undefined;
  }
  if (/^(checkpoint\b|lease:)/iu.test(meta)) {
    return undefined;
  }
  return meta;
}

function isVisibleWorkspaceSection(workspace: SwarmWorkbenchWorkspace, workspaceMeta: string | undefined): boolean {
  return workspace.path.trim().toLowerCase() === "no workspace" || Boolean(workspaceMeta);
}

function CaseRow({ session, width, onSelect }: { session: SwarmWorkbenchSessionItem; width: number; onSelect?: (id: string) => void }): React.ReactElement {
  const titleTone: TuiColorRef = session.active ? "brand.focus" : session.tone ?? "text.primary";
  const badge = visibleCaseBadge(session.badge);
  const subtitle = visibleCaseSubtitle(session.subtitle);
  const showSecondary = Boolean(badge || subtitle);
  const inlineAttention = session.attention && !showSecondary ? attentionLabel(session.attention) : undefined;
  const secondaryAttention = session.attention && showSecondary ? attentionLabel(session.attention) : undefined;
  const visibleAge = session.attention ? undefined : session.age;
  const ageWidth = visibleAge ? displayWidth(visibleAge) + 1 : 0;
  const attentionWidth = inlineAttention ? displayWidth(inlineAttention) + 1 : 0;
  const titleBudget = Math.max(8, width - ageWidth - attentionWidth - 6);
  return (
    <Box flexDirection="column" width="100%">
      <Text
        wrap="truncate"
        focusable={Boolean(onSelect)}
        onClick={onSelect ? (() => onSelect(session.id)) as never : undefined}
      >
        <Text color={session.active ? visualTokenColor("brand.focus") : visualTokenColor("text.muted")}>{session.active ? "> " : "  "}</Text>
        <Text color={resolveTuiColor(titleTone)}>{fitText(session.title || session.id, titleBudget)}</Text>
        {visibleAge ? <Text color={visualTokenColor("text.muted")}> {visibleAge}</Text> : null}
        {inlineAttention ? <Text color={visualTokenColor("status.warning")}> {inlineAttention}</Text> : null}
      </Text>
      {showSecondary ? (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          {"  "}
          {badge ? <Text color={resolveTuiColor(session.tone ?? "role.gateway")}>{fitText(badge, 10)}</Text> : null}
          {subtitle ? <Text> {fitText(subtitle, Math.max(8, width - 15))}</Text> : null}
          {secondaryAttention ? <Text color={visualTokenColor("status.warning")}> {secondaryAttention}</Text> : null}
        </Text>
      ) : null}
    </Box>
  );
}

function CaseList({
  sessions,
  width,
  onSelectSession
}: {
  sessions: SwarmWorkbenchSessionItem[];
  width: number;
  onSelectSession?: (id: string) => void;
}): React.ReactElement {
  return (
    <Box width="100%" flexDirection="column" marginTop={1} overflow="hidden">
      {sessions.slice(0, 6).map((session) => (
        <CaseRow key={session.id} session={session} width={width} onSelect={onSelectSession} />
      ))}
      {sessions.length > 6 ? <Text color={visualTokenColor("text.muted")}>{caseOverflowLabel(sessions.length - 6)}</Text> : null}
    </Box>
  );
}

function caseOverflowLabel(value: number): string {
  return `${value} more`;
}

function attentionLabel(value: number): string {
  if (value === 1) {
    return "needs you";
  }
  return `needs ${value}`;
}

function visibleCaseBadge(value: string | undefined): string | undefined {
  const badge = value?.trim();
  if (!badge) {
    return undefined;
  }
  const normalized = badge.toLowerCase().replace(/[_\s-]+/gu, "-");
  if (["active", "running", "review", "completed", "complete", "done", "success"].includes(normalized)) {
    return undefined;
  }
  return badge;
}

function visibleCaseSubtitle(value: string | undefined): string | undefined {
  const subtitle = value?.trim();
  if (!subtitle) {
    return undefined;
  }
  const normalized = subtitle.toLowerCase();
  if (normalized === "swarm" || normalized === "no workspace") {
    return undefined;
  }
  return subtitle;
}

function NavigationList({
  items,
  width,
  onNavigate,
  primary = false,
  marginTop = 1
}: {
  items: SwarmWorkbenchNavigationItem[];
  width: number;
  onNavigate?: (id: string) => void;
  primary?: boolean;
  marginTop?: number;
}): React.ReactElement {
  return (
    <Box width="100%" flexDirection="column" marginTop={marginTop} overflow="hidden">
      {items.map((item) => (
        <NavigationRow key={item.id} item={item} width={width} onNavigate={onNavigate} primary={primary} />
      ))}
    </Box>
  );
}

function isVisibleWorkbenchNavigationItem(item: SwarmWorkbenchNavigationItem): boolean {
  return Boolean(item.active);
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
  const labelBudget = Math.max(8, width - 6);
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
    </Text>
  );
}

function CenterHeader({ title, subtitle, detail, columns }: { title: string; subtitle?: string; detail?: string; columns: number }): React.ReactElement {
  const visibleSubtitle = subtitle === undefined ? undefined : visibleCenterHeaderSubtitle(subtitle);
  const visibleDetail = visibleCenterHeaderDetail(detail);
  return (
    <Box width="100%" height={visibleCenterHeaderRows(subtitle, detail)} flexDirection="column" overflow="hidden">
      <Text wrap="truncate">
        <Text color={visualTokenColor("brand.focus")} bold>{fitText(title, Math.max(12, columns - 2))}</Text>
      </Text>
      {visibleSubtitle ? (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          {visibleSubtitle}
        </Text>
      ) : null}
      {visibleDetail ? (
        <Text color={visualTokenColor("text.muted")} wrap="truncate">
          {visibleDetail}
        </Text>
      ) : null}
    </Box>
  );
}

function visibleCenterHeaderRows(subtitle: string | undefined, detail: string | undefined): number {
  const visibleSubtitle = subtitle === undefined ? undefined : visibleCenterHeaderSubtitle(subtitle);
  const visibleDetail = visibleCenterHeaderDetail(detail);
  return 1 + (visibleSubtitle ? 1 : 0) + (visibleDetail ? 1 : 0);
}

function visibleCenterHeaderSubtitle(value: string): string | undefined {
  const subtitle = value.trim();
  if (!subtitle) return undefined;
  const segments = subtitle.split(/\s*·\s*/u);
  const visibleSegments = segments
    .filter((segment) => !isZeroCountHeaderSegment(segment))
    .filter((segment) => !isRoutineHeaderCountSegment(segment))
    .map(normalizeHeaderCountSegment);
  return visibleSegments.length ? visibleSegments.join(" · ") : undefined;
}

function isZeroCountHeaderSegment(value: string): boolean {
  return /^0\s+[\p{L}\p{N}_-]+/iu.test(value.trim());
}

function isRoutineHeaderCountSegment(value: string): boolean {
  return /^\d+\s+(workers?|helpers?)$/iu.test(value.trim());
}

function normalizeHeaderCountSegment(value: string): string {
  if (/^1\s+active\s+tasks?$/iu.test(value.trim())) {
    return "Working";
  }
  return value
    .replace(/\b1(\s+active\s+)tasks\b/iu, "1$1task")
    .replace(/\b1(\s+)workers\b/iu, "1$1worker")
    .replace(/\b1(\s+)helpers\b/iu, "1$1helper")
    .replace(/\b1(\s+)approvals\b/iu, "1$1approval")
    .replace(/\b1(\s+)files\b/iu, "1$1file");
}

function visibleCenterHeaderDetail(value: string | undefined): string | undefined {
  const detail = value?.trim();
  if (!detail) return undefined;
  return /\b(reply below|open work stays here)\b/iu.test(detail) ? undefined : detail;
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
  const statusCard = activity ?? runtime ?? memory;
  const visibleStatusCard = visibleWorkbenchStatusCard(statusCard);
  const visibleWorkers = workers.filter(isVisibleWorkbenchWorker);
  const visibleTools = tools.filter(isVisibleWorkbenchTool);
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
      {isVisibleWorkbenchStatus(visibleStatusCard) ? <InfoSection card={visibleStatusCard} width={width} compact={compact} /> : null}
      {isVisibleWorkbenchMode(mode) ? <InfoSection title="Mode" card={mode} width={width} compact={compact} /> : null}
      {isVisibleWorkbenchAccess(permission) ? <InfoSection title="Access" card={permission} width={width} compact={compact} /> : null}
      {isVisibleWorkbenchSandbox(sandbox) ? <InfoSection title="Workspace" card={sandbox} width={width} compact={compact} /> : null}
      {visibleWorkers.length ? <WorkerSection workers={visibleWorkers} width={width} /> : null}
      {isVisibleWorkbenchAgent(model) ? <InfoSection title="Agent" card={model} width={width} compact={compact} /> : null}
      {visibleTools.length ? <ToolSection tools={visibleTools} width={width} compact={compact} /> : null}
    </ThemedBox>
  );
}

function hasVisibleRightRailContent({
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
  mode: SwarmWorkbenchInfoCard;
  runtime?: SwarmWorkbenchInfoCard;
  permission: SwarmWorkbenchInfoCard;
  sandbox: SwarmWorkbenchInfoCard;
  model: SwarmWorkbenchInfoCard;
  memory: SwarmWorkbenchInfoCard;
  activity?: SwarmWorkbenchInfoCard;
  tools: SwarmWorkbenchToolItem[];
  workers: SwarmWorkbenchWorkerItem[];
}): boolean {
  const statusCard = activity ?? runtime ?? memory;
  return isVisibleWorkbenchStatus(statusCard)
    || isVisibleWorkbenchMode(mode)
    || isVisibleWorkbenchAccess(permission)
    || isVisibleWorkbenchSandbox(sandbox)
    || workers.some(isVisibleWorkbenchWorker)
    || isVisibleWorkbenchAgent(model)
    || tools.some(isVisibleWorkbenchTool);
}

function InfoSection({
  title,
  card,
  width,
  progress = false,
  compact = false
}: {
  title?: string;
  card: SwarmWorkbenchInfoCard;
  width: number;
  progress?: boolean;
  compact?: boolean;
}): React.ReactElement {
  const tag = card.badge ? fixedTag(card.badge) : "";
  const valueWidth = Math.max(8, width - STATUS_TAG_WIDTH - 8);
  return (
    <SidebarSection title={title} width={width} marginTop={title ? (compact ? 0 : 1) : 0}>
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
    <Box width="100%" flexDirection="column" marginTop={compact ? 0 : 1} overflow="hidden">
      {tools.slice(0, compact ? 4 : 6).map((tool) => (
        <Text key={tool.name} wrap="truncate">
          <Text>{fitText(toolDisplayName(tool), Math.max(8, width - 20))}</Text>
          {tool.status ? <Text color={resolveTuiColor(tool.tone ?? (tool.active ? "status.success" : "text.muted"))}> {fitText(toolDisplayStatus(tool), 18)}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function toolDisplayName(tool: SwarmWorkbenchToolItem): string {
  const status = tool.status?.trim().toLowerCase() ?? "";
  if (tool.name.trim().toLowerCase() === "approvals" && status === "1 pending") {
    return "Needs";
  }
  return tool.name;
}

function toolDisplayStatus(tool: SwarmWorkbenchToolItem): string {
  const status = tool.status?.trim() ?? "";
  if (tool.name.trim().toLowerCase() === "approvals" && status.toLowerCase() === "1 pending") {
    return "approval";
  }
  return status;
}

function isVisibleWorkbenchTool(tool: SwarmWorkbenchToolItem): boolean {
  if (!tool.active) return false;
  const name = tool.name.trim().toLowerCase();
  const status = tool.status?.trim().toLowerCase() ?? "";
  if (!status) return true;
  if (isRoutineWorkbenchTool(name, status)) return false;
  return status !== "on" && status !== "ready" && !status.endsWith(" ready");
}

function isRoutineWorkbenchTool(name: string, status: string): boolean {
  return name === "automations" && status === "running";
}

function isVisibleWorkbenchStatus(card: SwarmWorkbenchInfoCard): boolean {
  const token = workbenchCardToken(card);
  return hasAttentionWorkbenchStatus(token) || !isRoutineWorkbenchStatus(card);
}

function visibleWorkbenchStatusCard(card: SwarmWorkbenchInfoCard): SwarmWorkbenchInfoCard {
  const subtitle = visibleWorkbenchStatusSubtitle(card.subtitle);
  return subtitle === card.subtitle ? card : { ...card, subtitle };
}

function visibleWorkbenchStatusSubtitle(value: string | undefined): string | undefined {
  const subtitle = value?.trim();
  if (!subtitle) {
    return undefined;
  }
  return /\b(?:planner|reviewer|worker|helper|agent)\b.*\bis running\b/iu.test(subtitle)
    ? undefined
    : subtitle;
}

function hasAttentionWorkbenchStatus(token: string): boolean {
  return /(?:^|-)(failed|error|risk|warning|pending|waiting|setup|degraded)(?:-|$)/u.test(token)
    || (/(?:^|-)blocked(?:-|$)/u.test(token) && !/(?:^|-)0-blocked(?:-|$)/u.test(token));
}

function isRoutineWorkbenchStatus(card: SwarmWorkbenchInfoCard): boolean {
  const token = workbenchCardToken(card);
  const subtitle = card.subtitle?.trim().toLowerCase().replace(/[_\s]+/gu, "-") ?? "";
  if (/(?:^|-)0-blocked(?:-|$)/u.test(token)) return true;
  return /^(ready|ready-ready|no-active-tasks|session-not-started)(?:-|$)/u.test(token)
    || /^no-(activity|saved-context)/u.test(subtitle);
}

function isVisibleWorkbenchMode(card: SwarmWorkbenchInfoCard): boolean {
  const token = workbenchCardToken(card);
  return token !== "plan-&-execute" && token !== "plan-&-execute-active";
}

function isVisibleWorkbenchAccess(card: SwarmWorkbenchInfoCard): boolean {
  const token = workbenchCardToken(card);
  return !/\b(ask|ask-before-edit|safe)\b/u.test(token);
}

function isVisibleWorkbenchSandbox(card: SwarmWorkbenchInfoCard): boolean {
  const token = workbenchCardToken(card);
  return !/\b(workspace-write|rw)\b/u.test(token);
}

function isVisibleWorkbenchAgent(card: SwarmWorkbenchInfoCard): boolean {
  const token = workbenchCardToken(card);
  return /\b(setup|not-connected|disabled|error|degraded)\b/u.test(token);
}

function workbenchCardToken(card: SwarmWorkbenchInfoCard): string {
  return `${card.title} ${card.badge ?? ""}`.trim().toLowerCase().replace(/[_\s]+/gu, "-");
}

function WorkerSection({ workers, width }: { workers: SwarmWorkbenchWorkerItem[]; width: number }): React.ReactElement {
  return (
    <Box width="100%" flexDirection="column" marginTop={0} overflow="hidden">
      {workers.slice(0, 3).map((worker) => (
        <Text key={worker.id} wrap="truncate">
          <Text>{fitText(worker.label, Math.max(8, width - 16))}</Text>
          {isVisibleWorkerStatus(worker.status) ? (
            <Text color={resolveTuiColor(worker.tone ?? "text.muted")}>  {workerStatusLabel(worker.status)}</Text>
          ) : null}
        </Text>
      ))}
    </Box>
  );
}

function isVisibleWorkbenchWorker(worker: SwarmWorkbenchWorkerItem): boolean {
  return isVisibleWorkerStatus(worker.status);
}

function isVisibleWorkerStatus(value: string): boolean {
  return !["active", "running"].includes(value.trim().toLowerCase());
}

function SidebarSection({
  title,
  width,
  children,
  marginTop = 1
}: {
  title?: string;
  width: number;
  children: React.ReactNode;
  marginTop?: number;
}): React.ReactElement {
  return (
    <Box width="100%" flexDirection="column" marginTop={marginTop} overflow="hidden">
      {title ? <SectionHeader title={title} width={width} /> : null}
      {children}
    </Box>
  );
}

function SectionHeader({ title, width }: { title: string; width: number }): React.ReactElement {
  const label = fitText(title, Math.max(4, width - 2));
  return (
    <Text wrap="truncate">
      <Text color={visualTokenColor("brand.focus")} bold>{label}</Text>
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
  const visibleItems = visibleWorkbenchFooterItems(items, columns);
  return (
    <Box width="100%" height={FOOTER_ROWS} flexDirection="row" overflow="hidden">
      {visibleItems.map((item, index) => (
        <React.Fragment key={`${item.key}:${item.label}`}>
          {index > 0 ? <Text color={visualTokenColor("text.muted")}>   </Text> : null}
          <Text color={resolveTuiColor(item.tone ?? "brand.focus")}>{item.label}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

function visibleWorkbenchFooterRows(items: Array<{ key: string; label: string; tone?: TuiColorRef }>, columns: number): number {
  return visibleWorkbenchFooterItems(items, columns).length ? FOOTER_ROWS : 0;
}

function visibleWorkbenchFooterItems(
  items: Array<{ key: string; label: string; tone?: TuiColorRef }>,
  columns: number
): Array<{ key: string; label: string; tone?: TuiColorRef }> {
  const maxItems = columns < 150 ? 6 : items.length;
  return items.filter(isVisibleWorkbenchFooterItem).slice(0, maxItems);
}

function isVisibleWorkbenchFooterItem(item: { key: string; label: string }): boolean {
  const label = item.label.trim().toLowerCase();
  return label !== "type a request" && label !== "ctrl+o details";
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
