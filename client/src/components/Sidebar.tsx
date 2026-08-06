import { useState } from "react";
import type { AgentProfile, AppState, SessionMeta, WorkspaceInfo } from "../types";
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
}

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

export function Sidebar(props: Props) {
  const { state, sessions, workspaces, agents, connected, activePanel, theme } = props;
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [sideTab, setSideTab] = useState<"sessions" | "files">("sessions");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const models = state?.availableModels ?? [];
  const current = state?.model;
  const currentKey = current ? `${current.provider}/${current.id}` : "";

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

      <div className="sidebar-section">运行配置</div>
      <div className="sel-row">
        <label>助手</label>
        <select value={state?.activeAgent?.id ?? "default"} onChange={(e) => props.onSetAgent(e.target.value)}>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
        <button className="icon-btn row-action-btn" title="Agent 管理" onClick={() => props.onPanel(activePanel === "agents" ? null : "agents")}>•••</button>
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
      <button className="new-session-btn" onClick={props.onNewSession}>
        <span>＋</span> 新会话
      </button>

      <div className="advanced-config">
        <button
          className={`advanced-toggle${showAdvanced ? " open" : ""}`}
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          <span className="advanced-caret">▸</span>
          <span>高级配置</span>
        </button>
        {showAdvanced && (
          <div className="advanced-body">
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
          </div>
        )}
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
        <div className="sidebar-section">
          浏览 <span className="section-action" title="刷新会话列表" onClick={props.onRefreshSessions}>↻</span>
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

      <div className="sidebar-mcp">
        <div className="mcp-head-row">
          <span className="mcp-title">扩展</span>
          <span className="mcp-status">MCP {connectedCount}/{mcpServers.length}</span>
        </div>
        <div className="mcp-actions">
          <button className="mini-btn" onClick={() => props.onPanel(activePanel === "mcp" ? null : "mcp")}>
            MCP
          </button>
          <button className="mini-btn" onClick={() => props.onPanel(activePanel === "skills" ? null : "skills")}>
            Skills
          </button>
        </div>
      </div>
    </div>
  );
}
