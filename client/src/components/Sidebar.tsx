import { useState, type CSSProperties, type ReactNode } from "react";
import type { AppState, ProjectSummary, SessionMeta, WechatStatus, WorkspaceInfo } from "../types";
import type { PanelTab } from "../App";
import { DirPicker } from "./DirPicker";
import { FileTree } from "./FileTree";

interface Props {
  style?: CSSProperties;
  state: AppState | null;
  sessions: SessionMeta[];
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  workspaces: WorkspaceInfo[];
  connected: boolean;
  wechatStatus?: WechatStatus | null;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  activePanel: PanelTab | null;
  onPanel: (tab: PanelTab | null) => void;
  onNewSession: () => void;
  onSwitchSession: (file: string) => void;
  onDeleteSession: (file: string) => void;
  onProjectSelect: (id: string | null) => void;
  onManageProjects: () => void;
  onNewProjectSession: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onAssignSession: (file: string, projectId: string | null) => void;
  onSwitchWorkspace: (path: string) => void;
  onAddWorkspace: (path: string) => void;
  onRefreshSessions: () => void;
  onSetThinking: (level: string) => void;
  onPickFile: (relPath: string, name: string) => void;
  onPickDir: (relPath: string) => void;
  onPreviewFile: (relPath: string, name: string) => void;
  onCollapse: () => void;
}

type SettingsSectionId = "models" | "extensions" | "agents" | "wechat";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface SettingsGroupProps {
  id: SettingsSectionId;
  title: string;
  badge?: string;
  open: boolean;
  onToggle: (id: SettingsSectionId) => void;
  children: ReactNode;
}

function SettingsGroup({ id, title, badge, open, onToggle, children }: SettingsGroupProps) {
  return (
    <div className={`settings-group${open ? " open" : ""}`}>
      <button className="settings-group-head" onClick={() => onToggle(id)} aria-expanded={open}>
        <span className="settings-caret">▸</span>
        <span className="settings-group-title">{title}</span>
        {badge && <span className="settings-group-badge">{badge}</span>}
      </button>
      {open && <div className="settings-group-body">{children}</div>}
    </div>
  );
}

export function Sidebar(props: Props) {
  const { state, sessions, projects, workspaces, connected, wechatStatus, activePanel, theme, style } = props;
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [sideTab, setSideTab] = useState<"sessions" | "files">("sessions");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);
  const [confirmingDeleteFile, setConfirmingDeleteFile] = useState<string | null>(null);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(new Set());
  const [confirmingDeleteProjectId, setConfirmingDeleteProjectId] = useState<string | null>(null);

  const sessionsByProject = new Map<string, SessionMeta[]>();
  const unassignedSessions: SessionMeta[] = [];
  for (const session of sessions) {
    if (session.projectId) {
      const group = sessionsByProject.get(session.projectId) ?? [];
      group.push(session);
      sessionsByProject.set(session.projectId, group);
    } else {
      unassignedSessions.push(session);
    }
  }

  // Keep the tree usable while the project summary request is still loading
  // (or when an older runtime only returns project data on each session).
  // This also prevents a project session from falling back to the old flat list.
  const visibleProjects = [...projects];
  const knownProjectIds = new Set(visibleProjects.map((project) => project.id));
  for (const session of sessions) {
    if (!session.projectId || knownProjectIds.has(session.projectId)) continue;
    knownProjectIds.add(session.projectId);
    visibleProjects.push({
      id: session.projectId,
      name: session.projectName?.trim() || "未命名项目",
      description: "",
      sessionCount: sessionsByProject.get(session.projectId)?.length ?? 0,
      memoryCount: 0,
      documentCount: 0,
      updatedAt: session.createdAt ?? Date.now(),
    });
  }

  const renderSession = (session: SessionMeta, nested = false) => (
    <div
      key={session.id}
      className={`session-item tree-session-item${nested ? " nested" : ""} ${state?.sessionFile === session.file ? "active" : ""}`}
      onClick={() => props.onSwitchSession(session.file)}
    >
      {nested && <span className="tree-branch" aria-hidden="true" />}
      <div className="name tree-session-name" title={session.name || session.firstMessage || session.file.split(/[\\/]/).pop()}>
        <span className="tree-session-label">{session.name || session.firstMessage || session.file.split(/[\\/]/).pop()}</span>
        {!session.projectId && (
          <select
            value={session.projectId ?? ""}
            title="归档到项目"
            onChange={(event) => { event.stopPropagation(); props.onAssignSession(session.file, event.target.value || null); }}
            className="tree-session-project-select"
          >
            <option value="">未归档</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        )}
        <button
          className={`session-delete-btn${confirmingDeleteFile === session.file ? " confirming" : ""}`}
          title={confirmingDeleteFile === session.file ? "再次点击确认删除" : "删除对话"}
          onClick={(event) => {
            event.stopPropagation();
            if (confirmingDeleteFile === session.file) {
              setConfirmingDeleteFile(null);
              props.onDeleteSession(session.file);
            } else {
              setConfirmingDeleteFile(session.file);
              window.setTimeout(() => setConfirmingDeleteFile((current) => current === session.file ? null : current), 3000);
            }
          }}
        >
          {confirmingDeleteFile === session.file ? "确认" : "×"}
        </button>
      </div>
      <div className="meta">{session.messageCount} 条消息 · {fmtTime(session.createdAt)}</div>
    </div>
  );

  const renderProjectGroup = (project: ProjectSummary) => {
    const projectSessions = sessionsByProject.get(project.id) ?? [];
    const collapsed = collapsedProjectIds.has(project.id);
    const confirming = confirmingDeleteProjectId === project.id;
    return (
      <div className="project-tree-group" key={project.id}>
        <div className="project-tree-head" onClick={() => setCollapsedProjectIds((current) => {
          const next = new Set(current);
          if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
          return next;
        })}>
          <button
            className="project-tree-toggle"
            aria-label={collapsed ? "展开项目" : "折叠项目"}
            title={collapsed ? "展开项目" : "折叠项目"}
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <span className="project-tree-name" title={project.name}>{project.name}</span>
          <div className="project-tree-actions">
            <button
              className="project-tree-action"
              title="在此项目中新建对话"
              onClick={(event) => { event.stopPropagation(); props.onNewProjectSession(project.id); }}
            >
              ＋
            </button>
            <button
              className={`project-tree-action project-tree-delete${confirming ? " confirming" : ""}`}
              title={confirming ? "再次点击确认删除项目" : "删除项目"}
              onClick={(event) => {
                event.stopPropagation();
                if (confirming) {
                  setConfirmingDeleteProjectId(null);
                  props.onDeleteProject(project.id);
                } else {
                  setConfirmingDeleteProjectId(project.id);
                  window.setTimeout(() => setConfirmingDeleteProjectId((current) => current === project.id ? null : current), 3000);
                }
              }}
            >
              {confirming ? "确认" : "×"}
            </button>
          </div>
        </div>
        {!collapsed && (
          <div className="project-tree-children">
            {projectSessions.length > 0
              ? projectSessions.map((session) => renderSession(session, true))
              : <div className="project-tree-empty">暂无会话</div>}
          </div>
        )}
      </div>
    );
  };
  const current = state?.model;
  const currentKey = current ? `${current.provider}/${current.id}` : "";
  const currentModelName = current?.displayName && !/^unknown(?:[/]unknown)?$/i.test(current.displayName)
    ? current.displayName
    : "";

  const mcp = state?.mcp;
  const mcpServers = mcp?.servers ?? [];
  const connectedCount = mcp?.connectedCount ?? 0;

  const toggleSettings = () => {
    const next = !settingsOpen;
    setSettingsOpen(next);
    if (next) setSettingsSection((s) => s ?? "models");
  };

  const openPanel = (tab: PanelTab) => {
    props.onPanel(tab);
    setSettingsOpen(false);
  };

  const toggleSettingsSection = (id: SettingsSectionId) => {
    setSettingsSection((current) => (current === id ? null : id));
  };

  return (
    <div className="sidebar" style={style}>
      <div className="sidebar-header">
        <div className="sidebar-brand-row">
          <div className="logo">
            <div className="logo-mark logo-image"><img src="/pi-studio-logo.png" alt="Pi Studio" /></div>
            <span>Pi Studio</span>
          </div>
          <div className="sidebar-header-actions">
            <button className="icon-btn header-icon-btn" title="折叠侧栏" onClick={props.onCollapse}>«</button>
            <button
              className="icon-btn header-icon-btn"
              title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
              onClick={props.onToggleTheme}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button className={`icon-btn header-icon-btn${settingsOpen ? " active" : ""}`} title="设置" onClick={toggleSettings}>
              ⚙
            </button>
          </div>
        </div>
        <div className="sidebar-status-line">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          <span>{connected ? "已连接" : "连接中"}</span>
          <span className="status-separator">·</span>
          <span>Pi {state?.piVersion ?? "0.83.0"}</span>
        </div>
      </div>

      <div className="sidebar-section first">工作区</div>
      <div className="sel-row workspace-row">
        <select
          value={state?.cwd ?? ""}
          onChange={(e) => {
            const p = e.target.value;
            if (p) props.onSwitchWorkspace(p);
          }}
          title={state?.cwd}
        >
          {workspaces.map((w) => (
            <option key={w.path} value={w.path}>
              {w.current ? "● " : ""}
              {w.name}
            </option>
          ))}
        </select>
        <button
          className="icon-btn"
          style={{ width: "24px", height: "24px", fontSize: "13px" }}
          title="选择工作区目录"
          onClick={() => setShowDirPicker(true)}
        >
          ＋
        </button>
      </div>

      {showDirPicker && (
        <DirPicker
          initialPath={state?.cwd}
          onSelect={(p) => {
            props.onAddWorkspace(p);
            props.onSwitchWorkspace(p);
            setShowDirPicker(false);
          }}
          onClose={() => setShowDirPicker(false)}
        />
      )}

      <div className="browse-area">
        <div className="sidebar-section browse-head">
          <span>浏览</span>
          <span className="browse-actions">
            <button className="icon-btn browse-action-btn" title="新会话" onClick={props.onNewSession}>＋</button>
            <button className="icon-btn browse-action-btn" title="刷新会话列表" onClick={props.onRefreshSessions}>↻</button>
          </span>
        </div>
      <div className="side-tabs">
          <div className={`side-tab ${sideTab === "sessions" ? "active" : ""}`} onClick={() => setSideTab("sessions")}>
            对话
          </div>
          <div className={`side-tab ${sideTab === "files" ? "active" : ""}`} onClick={() => setSideTab("files")}>
            文件
          </div>
      </div>
      {sideTab === "sessions" ? (
        <div className="session-list project-tree-list">
          {visibleProjects.map(renderProjectGroup)}
          <div className="project-tree-group unassigned-project-tree">
            <div className="project-tree-head" onClick={() => setCollapsedProjectIds((current) => {
              const next = new Set(current);
              if (next.has("__unassigned__")) next.delete("__unassigned__"); else next.add("__unassigned__");
              return next;
            })}>
              <button className="project-tree-toggle" aria-label="展开或折叠未归档会话" title="展开或折叠未归档会话">
                {collapsedProjectIds.has("__unassigned__") ? "▸" : "▾"}
              </button>
              <span className="project-tree-name">未归档会话</span>
            </div>
            {!collapsedProjectIds.has("__unassigned__") && (
              <div className="project-tree-children">
                {unassignedSessions.length > 0
                  ? unassignedSessions.map((session) => renderSession(session, true))
                  : <div className="project-tree-empty">暂无会话</div>}
              </div>
            )}
          </div>
          {projects.length === 0 && unassignedSessions.length === 0 && (
            <div className="project-tree-empty standalone">暂无会话</div>
          )}
        </div>
      ) : (
          <div className="session-list">
            <FileTree key={state?.cwd ?? ""} onPickFile={props.onPickFile} onPreview={props.onPreviewFile} onPickDir={props.onPickDir} />
          </div>
        )}
      </div>

      <div className="sidebar-section">功能</div>
      <div className="feature-grid">
        <button className={`feature-btn ${activePanel === "projects" ? "active" : ""}`} onClick={() => props.onPanel(activePanel === "projects" ? null : "projects")}>
          <span className="feature-icon">▣</span>
          <span>项目</span>
        </button>
        <button className={`feature-btn ${activePanel === "team" ? "active" : ""}`} onClick={() => props.onPanel(activePanel === "team" ? null : "team")}>
          <span className="feature-icon">◎</span>
          <span>团队任务</span>
        </button>
        <button className={`feature-btn ${activePanel === "schedules" ? "active" : ""}`} onClick={() => props.onPanel(activePanel === "schedules" ? null : "schedules")}>
          <span className="feature-icon">◷</span>
          <span>定时任务</span>
        </button>
      </div>

      {settingsOpen && (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="settings-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="设置">
            <div className="settings-head">
              <span className="panel-title">设置</span>
              <button className="icon-btn" title="关闭设置" onClick={() => setSettingsOpen(false)}>×</button>
            </div>
            <div className="settings-accordion">
            <SettingsGroup
              id="models"
              title="模型管理"
              badge={currentModelName || currentKey || "默认"}
              open={settingsSection === "models"}
              onToggle={toggleSettingsSection}
            >
              <div className="settings-status">
                <span>当前模型</span>
                <span className="settings-current">{currentModelName || currentKey || "默认"}</span>
              </div>
              <div className="sel-row" style={{ marginTop: "8px" }}>
                <label>思考强度</label>
                <select
                  value={state?.thinkingLevel ?? "off"}
                  onChange={(e) => props.onSetThinking(e.target.value)}
                >
                  {THINKING_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-actions">
                <button className="mini-btn primary" onClick={() => openPanel("models")}>打开模型管理</button>
              </div>
            </SettingsGroup>

            <SettingsGroup
              id="agents"
              title="智能体配置"
              badge={state?.activeAgent?.name || "默认"}
              open={settingsSection === "agents"}
              onToggle={toggleSettingsSection}
            >
              <div className="settings-status">
                <span>当前智能体</span>
                <span className="settings-current">{state?.activeAgent?.name || "默认"}</span>
              </div>
              <div className="settings-actions">
                <button className="mini-btn primary" onClick={() => openPanel("agents")}>打开智能体配置</button>
              </div>
            </SettingsGroup>

            <SettingsGroup
              id="extensions"
              title="扩展配置"
              badge={`MCP ${connectedCount}/${mcpServers.length}`}
              open={settingsSection === "extensions"}
              onToggle={toggleSettingsSection}
            >
              <div className="settings-actions">
                <button className="mini-btn" onClick={() => openPanel("mcp")}>MCP 管理</button>
                <button className="mini-btn" onClick={() => openPanel("skills")}>Skills</button>
              </div>
            </SettingsGroup>

            <SettingsGroup
              id="wechat"
              title="微信连接"
              badge={wechatStatus?.phase === "connected" ? "已连接" : "未连接"}
              open={settingsSection === "wechat"}
              onToggle={toggleSettingsSection}
            >
              <div className="settings-status">
                <span>当前状态</span>
                <span className="settings-current">{wechatStatus?.message || "未连接"}</span>
              </div>
              <div className="settings-actions">
                <button className="mini-btn primary" onClick={() => openPanel("wechat")}>打开微信连接</button>
              </div>
            </SettingsGroup>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
