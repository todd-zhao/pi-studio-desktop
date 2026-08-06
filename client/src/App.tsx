import { useCallback, useEffect, useRef, useState } from "react";
import { PiSocket, listAgents, listSessions, listWorkspaces, setActiveAgent } from "./api";
import type { AgentProfile, AppState, ClientMessage, McpStatusSnapshot, SessionMeta, AttachmentInfo, WorkspaceInfo } from "./types";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Composer, type ComposerHandle } from "./components/Composer";
import { McpPanel } from "./components/McpPanel";
import { ModelsPanel } from "./components/ModelsPanel";
import { SkillsPanel } from "./components/SkillsPanel";
import { AgentsPanel } from "./components/AgentsPanel";
import { TeamPanel } from "./components/TeamPanel";
import { FilePreview } from "./components/FilePreview";

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

export type PanelTab = "mcp" | "models" | "skills" | "agents" | "team";

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [connected, setConnected] = useState(false);
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

  const socketRef = useRef<PiSocket | null>(null);
  const composerRef = useRef<ComposerHandle | null>(null);
  const toastId = useRef(0);
  const stateRef = useRef<AppState | null>(null);
  const liveToolsRef = useRef<LiveTool[]>([]);
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
    [resetLive, toast],
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
          applyState(msg.state);
          void refreshSessions();
          void listWorkspaces()
            .then(setWorkspaces)
            .catch(() => {
              /* ignore */
            });
          void listAgents()
            .then((result) => setAgents(result.agents))
            .catch(() => {
              /* ignore */
            });
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

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      /* ignore */
    }
  }, []);

  const send = useCallback(
    (text: string, attachments?: AttachmentInfo[]) => {
      socketRef.current?.send({ type: "prompt", text, attachments });
    },
    [],
  );

  const sendToolCommand = useCallback((command: string) => {
    socketRef.current?.send({ type: "mcp_command", command });
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
        modelName={state?.model?.displayName ?? ""}
        onSend={send}
        onAbort={() => socketRef.current?.send({ type: "abort" })}
        onError={(m) => toast("error", m)}
      />
    </>
  );

  return (
    <div className="app">
      {sidebarOpen ? (
        <Sidebar
          state={state}
          sessions={sessions}
          workspaces={workspaces}
          agents={agents}
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
          onSetModel={(provider, id) => socketRef.current?.send({ type: "set_model", provider, id })}
          onSetThinking={(level) => socketRef.current?.send({ type: "set_thinking", level })}
          onSetAgent={(id) => {
            void setActiveAgent(id).catch((e) => toast("error", e.message));
          }}
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
      {preview && (
        <FilePreview
          file={preview}
          onClose={() => setPreview(null)}
          onInsertRef={(path) => handlePickFile(path, path.split("/").pop() ?? path)}
        />
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
