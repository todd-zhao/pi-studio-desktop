import { useState, type ReactNode } from "react";
import type { AgentProfile, AppState, SessionMeta, WechatStatus, WorkspaceInfo } from "../types";
import type { PanelTab } from "../App";
import { DirPicker } from "./DirPicker";
import { FileTree } from "./FileTree";

interface Props {
  state: AppState | null;
  sessions: SessionMeta[];
  workspaces: WorkspaceInfo[];
  agents: AgentProfile[];
  connected: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  activePanel: PanelTab | null;
  onPanel: (tab: PanelTab | null) => void;
  onNewSession: () => void;
  onSwitchSession: (file: string) => void;
  onSwitchWorkspace: (path: string) => void;
  onAddWorkspace: (path: string) => void;
  onRefreshSessions: () => void;
  onSetModel: (provider: string, id: string) => void;
  onSetThinking: (level: string) => void;
  onSetAgent: (id: string) => void;
  onPickFile: (relPath: string, name: string) => void;
  onPreviewFile: (relPath: string, name: string) => void;
  onCollapse: () => void;
  subagentsEnabled: boolean;
  onToggleSubagents: (enabled: boolean) => void;
  goalsEnabled: boolean; goalText: string; onGoalTextChange: (value: string) => void; onSaveGoalText: (value: string) => void; onToggleGoals: (enabled: boolean) => void;
  wechatStatus: WechatStatus | null;
}

type SettingsSectionId = "runtime" | "models" | "advanced" | "extensions" | "wechat";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const WECHAT_PHASE_LABEL: Record<WechatStatus["phase"], string> = {
  idle: "未连接",
  connecting: "连接中",
  qr: "等待扫码",
  scanned: "已扫码",
  expired: "二维码过期",
  connected: "已连接",
  error: "连接异常",
};

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
  const { state, sessions, workspaces, agents, connected, activePanel, theme } = props;
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [sideTab, setSideTab] = useState<"sessions" | "files">("sessions");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);

  const models = state?.availableModels ?? [];
  const current = state?.model;
  const currentKey = current ? `${current.provider}/${current.id}` : "";
  const currentModelName = current?.displayName && !/^unknown(?:[/]unknown)?$/i.test(current.displayName)
    ? current.displayName
    : "";

  // group models by provider
  const groups = new Map<string, typeof models>();
  for (const m of models) {
    const g = groups.get(m.provider) ?? [];
    g.push(m);
    groups.set(m.provider, g);
  }

  const mcp = state?.mcp;
  const mcpServers = mcp?.servers ?? [];
  const connectedCount = mcp?.connectedCount ?? 0;
  const wechatPhase = props.wechatStatus?.phase ?? "idle";

  const toggleSettings = () => {
    const next = !settingsOpen;
    setSettingsOpen(next);
    if (next) setSettingsSection((s) => s ?? "runtime");
  };

  const openPanel = (tab: PanelTab) => {
    props.onPanel(tab);
    setSettingsOpen(false);
  };

  const toggleSettingsSection = (id: SettingsSectionId) => {
    setSettingsSection((current) => (current === id ? null : id));
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand-row">
          <div className="logo">
            <div className="logo-mark logo-image"><img src="/pi-studio-logo.svg" alt="Pi Studio" /></div>
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
          <div className="session-list">
            {sessions.length === 0 && (
              <div style={{ padding: "8px 10px", color: "var(--text-3)", fontSize: "12px" }}>
                暂无对话
              </div>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item ${state?.sessionFile === s.file ? "active" : ""}`}
                onClick={() => props.onSwitchSession(s.file)}
              >
                <div className="name">{s.name || s.firstMessage || s.file.split(/[\\/]/).pop()}</div>
                <div className="meta">
                  {s.messageCount} 条消息 · {fmtTime(s.createdAt)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="session-list">
            <FileTree key={state?.cwd ?? ""} onPickFile={props.onPickFile} onPreview={props.onPreviewFile} />
          </div>
        )}
      </div>

      <div className="sidebar-section">功能</div>
      <div className="feature-grid">
        <button className={`feature-btn ${activePanel === "team" ? "active" : ""}`} onClick={() => props.onPanel(activePanel === "team" ? null : "team")}>
          <span className="feature-icon">◎</span>
          <span>团队任务</span>
        </button>
        <button className={`feature-btn ${activePanel === "schedules" ? "active" : ""}`} onClick={() => props.onPanel(activePanel === "schedules" ? null : "schedules")}>
          <span className="feature-icon">◷</span>
          <span>定时任务</span>
        </button>
        <button className={`feature-btn ${activePanel === "wechat" ? "active" : ""}`} onClick={() => props.onPanel(activePanel === "wechat" ? null : "wechat")}>
          <span className="feature-icon">◈</span>
          <span>微信对话</span>
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
              <SettingsGroup id="runtime" title="运行设置" open={settingsSection === "runtime"} onToggle={toggleSettingsSection}>
                <div className="sel-row">
                  <label>助手</label>
                  <select value={state?.activeAgent?.id ?? "default"} onChange={(e) => props.onSetAgent(e.target.value)}>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                  <button className="icon-btn row-action-btn" title="Agent 管理" onClick={() => openPanel("agents")}>•••</button>
                </div>
                <div className="sel-row">
                  <label>模型</label>
                  <select
                    value={currentKey}
                    onChange={(e) => {
                      const [provider, ...rest] = e.target.value.split("/");
                      const id = rest.join("/");
                      if (provider && id) props.onSetModel(provider, id);
                    }}
                  >
                    {currentKey === "" && <option value="">（默认）</option>}
                    {[...groups.entries()].map(([provider, list]) => (
                      <optgroup key={provider} label={provider}>
                        {list.map((m) => (
                          <option key={`${provider}/${m.id}`} value={`${provider}/${m.id}`}>
                            {m.id}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div className="sel-row">
                  <label>思考</label>
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
              </SettingsGroup>

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
                <div className="settings-actions">
                  <button className="mini-btn primary" onClick={() => openPanel("models")}>打开模型管理</button>
                </div>
              </SettingsGroup>

              <SettingsGroup
                id="advanced"
                title="高级配置"
                badge={props.subagentsEnabled || props.goalsEnabled ? "已启用" : "关闭"}
                open={settingsSection === "advanced"}
                onToggle={toggleSettingsSection}
              >
                <div className="sel-row subagents-toggle">
                  <label>多智能体</label>
                  <button className={`toggle-switch ${props.subagentsEnabled ? "on" : ""}`} onClick={() => props.onToggleSubagents(!props.subagentsEnabled)} aria-pressed={props.subagentsEnabled}><span /></button>
                  <small>{props.subagentsEnabled ? "已开启" : "关闭"}</small>
                </div>
                <div className="goal-control">
                  <div className="sel-row subagents-toggle">
                    <label>长时目标审查</label>
                    <button className={`toggle-switch ${props.goalsEnabled ? "on" : ""}`} onClick={() => props.onToggleGoals(!props.goalsEnabled)} aria-pressed={props.goalsEnabled}><span /></button>
                    <small>{props.goalsEnabled ? "已开启" : "关闭"}</small>
                  </div>
                  <textarea value={props.goalText} placeholder="设定长时目标，例如：完成登录重构并通过完整测试" onChange={(e) => props.onGoalTextChange(e.target.value)} onBlur={(e) => props.onSaveGoalText(e.currentTarget.value)} />
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
                badge={WECHAT_PHASE_LABEL[wechatPhase]}
                open={settingsSection === "wechat"}
                onToggle={toggleSettingsSection}
              >
                <div className="settings-status">
                  <span>连接状态</span>
                  <span className="settings-current">{WECHAT_PHASE_LABEL[wechatPhase]}</span>
                  {props.wechatStatus?.account && <code className="settings-current">{props.wechatStatus.account}</code>}
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
