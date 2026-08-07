import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PiSocket, getGoals, getSubagents, listAgents, listSessions, retryBoot, setActiveAgent, setGoals, setSubagents } from "./api";
import type { AgentProfile, AppState, AskUserQuestion, ClientMessage, McpStatusSnapshot, SessionMeta, AttachmentInfo, WechatCommandAction, WechatLogEntry, WechatQr, WechatStatus, WorkspaceInfo } from "./types";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Composer, type ComposerHandle } from "./components/Composer";
const McpPanel = lazy(() => import("./components/McpPanel").then((module) => ({ default: module.McpPanel })));
const ModelsPanel = lazy(() => import("./components/ModelsPanel").then((module) => ({ default: module.ModelsPanel })));
const SkillsPanel = lazy(() => import("./components/SkillsPanel").then((module) => ({ default: module.SkillsPanel })));
const AgentsPanel = lazy(() => import("./components/AgentsPanel").then((module) => ({ default: module.AgentsPanel })));
const TeamPanel = lazy(() => import("./components/TeamPanel").then((module) => ({ default: module.TeamPanel })));
const SchedulesPanel = lazy(() => import("./components/SchedulesPanel").then((module) => ({ default: module.SchedulesPanel })));
const WechatPanel = lazy(() => import("./components/WechatPanel").then((module) => ({ default: module.WechatPanel })));
const FilePreview = lazy(() => import("./components/FilePreview").then((module) => ({ default: module.FilePreview })));

export interface LiveTool {
  key: string;
  name: string;
  status: "running" | "done" | "error";
  args?: string;
  output?: string;
}

export interface Toast {
  id: number;
  level: "info" | "warn" | "error" | "ok";
  message: string;
}

export interface RenderedMessage extends ClientMessage {
  toolResults?: Record<string, { text: string; isError: boolean }>;
}

export type PanelTab = "mcp" | "models" | "skills" | "agents" | "team" | "schedules" | "wechat";

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connected, setConnected] = useState(false);
  const [bootStatus, setBootStatus] = useState<{ state: "booting" | "error" | "ready"; message?: string }>({ state: "booting" });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const urlTheme = new URLSearchParams(location.search).get("theme");
      if (urlTheme === "light" || urlTheme === "dark") return urlTheme;
      const saved = localStorage.getItem("pi-studio-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* ignore */
    }
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  // Live streaming region (client-side draft, reconciled by server snapshots)
  const [liveText, setLiveText] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [queued, setQueued] = useState<{ steering: number; followUp: number } | null>(null);
  const [subagentsEnabled, setSubagentsEnabled] = useState(false);
  const [goalsEnabled, setGoalsEnabled] = useState(false);
  const [goalText, setGoalText] = useState("");
  const [wechatStatus, setWechatStatus] = useState<WechatStatus | null>(null);
  const [wechatQr, setWechatQr] = useState<WechatQr | null>(null);
  const [wechatLogs, setWechatLogs] = useState<WechatLogEntry[]>([]);
  const [oneShot, setOneShot] = useState<{ subagents: boolean; goals: boolean }>({ subagents: false, goals: false });
  const [question, setQuestion] = useState<AskUserQuestion | null>(null);
  const [customAnswer, setCustomAnswer] = useState("");

  const socketRef = useRef<PiSocket | null>(null);
  const composerRef = useRef<ComposerHandle | null>(null);
  const toastId = useRef(0);
  const stateRef = useRef<AppState | null>(null);
  const liveToolsRef = useRef<LiveTool[]>([]);
  const restoreRef = useRef<{ subagents: boolean; goals: boolean }>({ subagents: false, goals: false });
  const subagentsEnabledRef = useRef(subagentsEnabled);
  subagentsEnabledRef.current = subagentsEnabled;
  const goalsEnabledRef = useRef(goalsEnabled);
  goalsEnabledRef.current = goalsEnabled;
  const goalTextRef = useRef(goalText);
  goalTextRef.current = goalText;
  const oneShotRef = useRef(oneShot);
  oneShotRef.current = oneShot;
  stateRef.current = state;

  const toast = useCallback((level: Toast["level"], message: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-4), { id, level, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const resetLive = useCallback(() => {
    setLiveText("");
    setLiveThinking("");
    setLiveTools([]);
    liveToolsRef.current = [];
    setQueued(null);
  }, []);

  const restoreOneShot = useCallback(() => {
    const restore = restoreRef.current;
    if (restore.subagents) {
      restore.subagents = false;
      setSubagentsEnabled(false);
      void setSubagents(false).catch((e) => toast("error", e.message));
    }
    if (restore.goals) {
      restore.goals = false;
      setGoalsEnabled(false);
      void setGoals(false, goalTextRef.current).catch((e) => toast("error", e.message));
    }
  }, [toast]);

  const handleEvent = useCallback(
    (event: unknown) => {
      const e = event as {
        type: string;
        assistantMessageEvent?: { type: string; delta?: string; thinking?: string };
        toolName?: string;
        toolCallId?: string;
        isError?: boolean;
        result?: unknown;
        content?: unknown;
        steering?: unknown[];
        followUp?: unknown[];
      };

      switch (e.type) {
        case "message_update": {
          const a = e.assistantMessageEvent;
          if (a?.type === "text_delta") setLiveText((t) => t + (a.delta ?? ""));
          else if (a?.type === "thinking_delta") setLiveThinking((t) => t + (a.delta ?? ""));
          break;
        }
        case "tool_execution_start": {
          const tool: LiveTool = {
            key: `${e.toolCallId ?? "t"}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: e.toolName ?? "tool",
            status: "running",
          };
          liveToolsRef.current = [...liveToolsRef.current, tool];
          setLiveTools(liveToolsRef.current);
          break;
        }
        case "tool_execution_update": {
          const content = e.content;
          if (typeof content === "string") {
            liveToolsRef.current = liveToolsRef.current.map((t, i) =>
              i === liveToolsRef.current.length - 1 ? { ...t, output: (t.output ?? "") + content } : t,
            );
            setLiveTools([...liveToolsRef.current]);
          }
          break;
        }
        case "tool_execution_end": {
          liveToolsRef.current = liveToolsRef.current.map((t, i) =>
            i === liveToolsRef.current.length - 1
              ? { ...t, status: e.isError ? "error" : "done", output: formatResult(e.result) }
              : t,
          );
          setLiveTools([...liveToolsRef.current]);
          break;
        }
        case "queue_update": {
          setQueued({ steering: e.steering?.length ?? 0, followUp: e.followUp?.length ?? 0 });
          break;
        }
        case "agent_end":
        case "agent_settled":
          restoreOneShot();
          resetLive();
          break;
        case "auto_retry_start":
          toast("warn", "模型出错，自动重试中…");
          break;
        case "compaction_start":
          toast("info", "上下文压缩中…");
          break;
      }
    },
    [resetLive, restoreOneShot, toast],
  );

  const applyState = useCallback((s: AppState) => {
    setState(s);
    if (!s.isStreaming) resetLive();
  }, [resetLive]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("pi-studio-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Close the file preview when the workspace changes (paths become stale).
  useEffect(() => {
    setPreview(null);
  }, [state?.cwd]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  useEffect(() => {
    const socket = new PiSocket();
    socketRef.current = socket;

    const off = socket.on((msg) => {
      switch (msg.type) {
        case "ready":
          setConnected(true);
          setBootStatus({ state: "ready" });
          applyState(msg.state);
          if (msg.sessions) setSessions(msg.sessions);
          if (msg.workspaces) setWorkspaces(msg.workspaces);
          void Promise.all([
            getSubagents().then((v) => setSubagentsEnabled(v.enabled)).catch(() => {}),
            getGoals().then((v) => { setGoalsEnabled(v.enabled); setGoalText(v.goal); }).catch(() => {}),
            listAgents().then((result) => setAgents(result.agents)).catch(() => {}),
          ]);
          break;
        case "initial_state":
          setSessions(msg.sessions);
          setWorkspaces(msg.workspaces);
          break;
        case "state":
          applyState(msg.state);
          break;
        case "event":
          handleEvent(msg.event);
          break;
        case "mcp_status":
          setState((s) => (s ? { ...s, mcp: msg.snapshot as McpStatusSnapshot } : s));
          break;
        case "sessions":
          setSessions(msg.sessions);
          break;
        case "workspaces":
          setWorkspaces(msg.workspaces);
          break;
        case "log":
          toast(msg.level === "error" ? "error" : msg.level === "warn" ? "warn" : "info", msg.message);
          break;
        case "error":
          toast("error", msg.message);
          break;
        case "booting":
          setConnected(false);
          setBootStatus({ state: "booting", message: msg.message ?? msg.phase });
          break;
        case "boot_error":
          setConnected(false);
          setBootStatus({ state: "error", message: msg.message });
          break;
        case "ask_user":
          setCustomAnswer("");
          setQuestion(msg.question);
          break;
        case "wechat_status":
          setWechatStatus(msg.status);
          if (msg.status.phase === "connected" || msg.status.phase === "idle") setWechatQr(null);
          break;
        case "wechat_qr":
          setWechatQr(msg.qr);
          break;
        case "wechat_log":
          setWechatLogs((logs) => [...logs.slice(-199), msg.entry]);
          break;
      }
    });

    socket.connect();
    // Optional deep-link: ?session=<absolute session file path>
    const deepLink = new URLSearchParams(location.search).get("session");
    if (deepLink) {
      const t = window.setTimeout(() => socket.send({ type: "switch_session", file: deepLink }), 800);
      return () => {
        window.clearTimeout(t);
        off();
        socket.close();
      };
    }
    return () => {
      off();
      socket.close();
    };
  }, [applyState, handleEvent, toast]);

  const retryInitialization = useCallback(async () => {
    setBootStatus({ state: "booting", message: "Retrying AI engine initialization" });
    try {
      await retryBoot();
      socketRef.current?.close();
      socketRef.current?.connect();
    } catch (error) {
      setBootStatus({ state: "error", message: (error as Error).message });
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      /* ignore */
    }
  }, []);

  const send = useCallback(
    async (text: string, attachments?: AttachmentInfo[]) => {
      const one = oneShotRef.current;
      try {
        if (one.subagents && !subagentsEnabledRef.current) {
          restoreRef.current.subagents = true;
          await setSubagents(true);
          setSubagentsEnabled(true);
        }
        if (one.goals && !goalsEnabledRef.current) {
          restoreRef.current.goals = true;
          await setGoals(true, goalTextRef.current);
          setGoalsEnabled(true);
        }
      } catch (e) {
        toast("error", (e as Error).message);
        return;
      }
      if (one.subagents || one.goals) setOneShot({ subagents: false, goals: false });
      socketRef.current?.send({ type: "prompt", text, attachments });
    },
    [toast],
  );

  const sendToolCommand = useCallback((command: string) => {
    socketRef.current?.send({ type: "mcp_command", command });
  }, []);

  const sendWechatCommand = useCallback((action: WechatCommandAction) => {
    socketRef.current?.send({ type: "wechat_command", action });
  }, []);

  const switchSession = useCallback((file: string) => {
    socketRef.current?.send({ type: "switch_session", file });
    setPanel(null);
  }, []);

  const handlePickFile = useCallback((relPath: string, _name: string) => {
    composerRef.current?.insertText(`@${relPath}`);
  }, []);

  const newSession = useCallback(() => {
    socketRef.current?.send({ type: "new_session" });
  }, []);

  const switchWorkspace = useCallback((path: string) => {
    socketRef.current?.send({ type: "switch_workspace", path });
    setPanel(null);
  }, []);

  const addWorkspace = useCallback((path: string) => {
    socketRef.current?.send({ type: "add_workspace", path });
  }, []);

  // fold tool results into the assistant message that owns the tool call
  const renderedMessages = useMemoMessages(state?.messages ?? []);

  const isEmpty = !!state && state.messages.length === 0 && !state.isStreaming;

  const mainContent = (
    <>
      <Chat
        messages={renderedMessages}
        live={{ liveText, liveThinking, liveTools }}
        queued={queued}
        isStreaming={state?.isStreaming ?? false}
      />
      <Composer
        ref={composerRef}
        isStreaming={state?.isStreaming ?? false}
        model={state?.model ?? null}
        models={state?.availableModels ?? []}
        activeAgentId={state?.activeAgent?.id}
        agents={agents}
        onSend={send}
        onAbort={() => socketRef.current?.send({ type: "abort" })}
        onSetModel={(provider, id) => socketRef.current?.send({ type: "set_model", provider, id })}
        onSetAgent={(id) => {
          void setActiveAgent(id).catch((e) => toast("error", e.message));
        }}
        onError={(m) => toast("error", m)}
        oneShot={oneShot}
        onTaskModeChange={(next) => setOneShot(next)}
        goalText={goalText}
        onGoalTextChange={setGoalText}
        onSaveGoalText={(goal) => void setGoals(goalsEnabled, goal).then((v) => { setGoalText(v.goal); }).catch((e) => toast("error", e.message))}
      />
    </>
  );
  const answerQuestion = (answer: string) => {
    if (!question || !answer.trim()) return;
    socketRef.current?.send({ type: "ask_user_answer", id: question.id, answer: answer.trim() });
    setQuestion(null); setCustomAnswer("");
  };

  return (
    <div className="app">
      {bootStatus.state !== "ready" && (
        <div className="boot-overlay" role="status" aria-live="polite">
          <div className="boot-card">
            <div className="boot-indicator" aria-hidden="true" />
            <strong>{bootStatus.state === "error" ? "AI 引擎初始化失败" : "AI 引擎初始化中"}</strong>
            <span>{bootStatus.message || "正在准备本地运行环境"}</span>
            {bootStatus.state === "error" && <button className="btn primary" onClick={() => void retryInitialization()}>重试</button>}
          </div>
        </div>
      )}
      {sidebarOpen ? (
        <Sidebar
          state={state}
          sessions={sessions}
          workspaces={workspaces}
          connected={connected}
          theme={theme}
          onToggleTheme={toggleTheme}
          activePanel={panel}
          onPanel={setPanel}
          onNewSession={newSession}
          onSwitchSession={switchSession}
          onSwitchWorkspace={switchWorkspace}
          onAddWorkspace={addWorkspace}
          onPickFile={handlePickFile}
          onPreviewFile={(path, name) => setPreview({ path, name })}
          onCollapse={() => setSidebarOpen(false)}
          onRefreshSessions={() => void refreshSessions()}
          onSetThinking={(level) => socketRef.current?.send({ type: "set_thinking", level })}
        />
      ) : (
        <button className="sidebar-rail" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
          »
        </button>
      )}
      <div className={`main ${isEmpty ? "has-empty" : ""}`}>
        <div className="main-header">
          <span className="main-title">Pi Studio</span>
          {state?.piVersion && <span className="version-badge">Pi v{state.piVersion}</span>}
          <span className="main-sub">
            {state?.model?.displayName ?? ""}
            {state?.cwd ? ` · ${state.cwd.split(/[\\/]/).pop()}` : ""}
          </span>
        </div>
        {isEmpty ? <div className="main-center">{mainContent}</div> : mainContent}
      </div>
      <Suspense fallback={panel || preview ? <div className="right-panel panel-loading">加载面板中…</div> : null}>
      {panel === "mcp" && (
        <div className="right-panel">
          <McpPanel mcp={state?.mcp ?? null} onCommand={sendToolCommand} onClose={() => setPanel(null)} onToast={toast} />
        </div>
      )}
      {panel === "models" && (
        <div className="right-panel">
          <ModelsPanel
            current={state?.model ? { provider: state.model.provider, id: state.model.id } : null}
            onSelect={(provider, id) => socketRef.current?.send({ type: "set_model", provider, id })}
            onClose={() => setPanel(null)}
            onToast={toast}
          />
        </div>
      )}
      {panel === "skills" && (
        <div className="right-panel">
          <SkillsPanel onClose={() => setPanel(null)} onToast={toast} />
        </div>
      )}
      {panel === "agents" && (
        <div className="right-panel">
          <AgentsPanel
            activeAgentId={state?.activeAgent?.id}
            onActiveChange={(agent) => setState((current) => (current ? { ...current, activeAgent: agent } : current))}
            onAgentsChange={setAgents}
            onClose={() => setPanel(null)}
            onToast={toast}
          />
        </div>
      )}
      {panel === "team" && (
        <div className="right-panel team-right-panel">
          <TeamPanel onClose={() => setPanel(null)} onToast={toast} />
        </div>
      )}
      {panel === "schedules" && <div className="right-panel"><SchedulesPanel agents={agents} onClose={() => setPanel(null)} onToast={toast} /></div>}
      {panel === "wechat" && (
        <div className="right-panel wechat-right-panel">
          <WechatPanel status={wechatStatus} qr={wechatQr} logs={wechatLogs} onCommand={sendWechatCommand} onClose={() => setPanel(null)} />
        </div>
      )}
      {preview && (
        <FilePreview
          file={preview}
          onClose={() => setPreview(null)}
          onInsertRef={(path) => handlePickFile(path, path.split("/").pop() ?? path)}
        />
      )}
      </Suspense>
      {question && (
        <div className="ask-user-backdrop" role="dialog" aria-modal="true" aria-label="Agent 澄清问题">
          <div className="ask-user-card">
            <div className="ask-user-kicker">Agent 需要确认</div>
            <h2>{question.question}</h2>
            <div className="ask-user-options">
              {question.options.map((option) => <button key={option.label} className="ask-user-option" onClick={() => answerQuestion(option.label)}><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</button>)}
            </div>
            {question.allowFreeform && <div className="ask-user-freeform"><input autoFocus value={customAnswer} placeholder="输入你的想法…" onChange={(e) => setCustomAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") answerQuestion(customAnswer); }} /><button className="btn primary" disabled={!customAnswer.trim()} onClick={() => answerQuestion(customAnswer)}>提交</button></div>}
          </div>
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function useMemoMessages(messages: ClientMessage[]): RenderedMessage[] {
  // attach toolResult messages to their owning assistant toolCall (as output)
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolCallId) {
      results.set(m.toolCallId, { text: m.text, isError: !!m.isError });
    }
  }

  return messages
    .filter((m) => m.role !== "toolResult")
    .map((m) => {
      if (m.role === "assistant" && m.toolCalls?.length) {
        const toolResults: Record<string, { text: string; isError: boolean }> = {};
        for (const c of m.toolCalls) {
          const r = results.get(c.id);
          if (r) toolResults[c.id] = r;
        }
        return { ...m, toolResults };
      }
      return { ...m };
    });
}
