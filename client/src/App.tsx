import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { saveProjectMemory, setActiveAgent, setGoals } from "./api";
import { Composer, type ComposerHandle } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { DirPicker } from "./components/DirPicker";
import { Chat } from "./components/Chat";
import { LongTaskQueue } from "./components/LongTaskQueue";
import { Markdown } from "./components/markdown";
import { useLiveSocket } from "./hooks/useLiveSocket";
import { useSessions } from "./hooks/useSessions";
import { useToasts } from "./hooks/useToasts";
import { useLayout } from "./hooks/useLayout";
import { useTheme } from "./hooks/useTheme";
import { useMemoMessages, type PanelTab, type RenderedMessage } from "./types-app";

const McpPanel = lazy(() => import("./components/McpPanel").then((module) => ({ default: module.McpPanel })));
const ModelsPanel = lazy(() => import("./components/ModelsPanel").then((module) => ({ default: module.ModelsPanel })));
const SkillsPanel = lazy(() => import("./components/SkillsPanel").then((module) => ({ default: module.SkillsPanel })));
const AgentsPanel = lazy(() => import("./components/AgentsPanel").then((module) => ({ default: module.AgentsPanel })));
const TeamPanel = lazy(() => import("./components/TeamPanel").then((module) => ({ default: module.TeamPanel })));
const SchedulesPanel = lazy(() => import("./components/SchedulesPanel").then((module) => ({ default: module.SchedulesPanel })));
const WechatPanel = lazy(() => import("./components/WechatPanel").then((module) => ({ default: module.WechatPanel })));
const ProjectsPanel = lazy(() => import("./components/ProjectsPanel").then((module) => ({ default: module.ProjectsPanel })));
const ArchivedSessionsPanel = lazy(() => import("./components/ArchivedSessionsPanel").then((module) => ({ default: module.ArchivedSessionsPanel })));
const FilePreview = lazy(() => import("./components/FilePreview").then((module) => ({ default: module.FilePreview })));

// Re-export shared types so existing component imports (from "../App") keep working.
export type { LiveTool, QueuedItem, LiveSnapshot, Toast, RenderedMessage, PanelTab } from "./types-app";

export default function App() {
  const { toasts, toast } = useToasts();
  const { theme, toggleTheme } = useTheme();
  const { sidebarOpen, setSidebarOpen, sidebarWidth, rightPanelWidth, startResize } = useLayout();

  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [preview, setPreview] = useState<{ path: string; name: string; root?: string } | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle | null>(null);
  const openTabsInitializedRef = useRef(false);

  // useSessions needs `send`/`state` from useLiveSocket, while useLiveSocket needs
  // the session setters from useSessions — break the cycle through a ref.
  const liveRef = useRef<ReturnType<typeof useLiveSocket> | null>(null);
  const sessionsApi = useSessions({
    send: (msg) => liveRef.current?.sendMessage(msg),
    toast,
    activeSessionFile: liveRef.current?.state?.sessionFile,
    closePanel: () => setPanel(null),
  });
  const live = useLiveSocket({
    toast,
    setSessions: sessionsApi.setSessions,
    setWorkspaces: sessionsApi.setWorkspaces,
    setProjects: sessionsApi.setProjects,
  });
  liveRef.current = live;

  const {
    state,
    setState,
    connected,
    bootStatus,
    agents,
    setAgents,
    liveText,
    liveThinking,
    liveTools,
    queued,
    goalsEnabled,
    goalText,
    setGoalText,
    wechatStatus,
    wechatQr,
    wechatLogs,
    oneShot,
    setOneShot,
    questions,
    questionAnswers,
    setQuestionAnswers,
    sendMessage,
    send,
    steer,
    cancelQueued,
    editQueued,
    sendToolCommand,
    sendWechatCommand,
    retryInitialization,
    answerQuestion,
  } = live;
  const {
    sessions,
    setProjects,
    projects,
    archivedSessions,
    openTabFiles,
    setOpenTabFiles,
    refreshSessions,
    refreshArchived,
    handleDeleteSession,
    handleArchiveSession,
    handleRestoreArchived,
    handleDeleteArchived,
    assignSession,
    newProjectSession,
    deleteProject,
    archiveProject,
    switchSession,
    newSession,
    closeTab,
  } = sessionsApi;

  // Close the file preview when the workspace changes (paths become stale).
  useEffect(() => {
    setPreview(null);
  }, [state?.cwd]);

  useEffect(() => {
    if (panel === "archived") void refreshArchived();
  }, [panel, refreshArchived]);

  useEffect(() => {
    if (openTabsInitializedRef.current || sessions.length === 0) return;
    openTabsInitializedRef.current = true;
    setOpenTabFiles(sessions.slice(0, 8).map((session) => session.file));
  }, [sessions]);

  useEffect(() => {
    const file = state?.sessionFile;
    if (!file) return;
    setOpenTabFiles((prev) => (prev.includes(file) ? prev : [...prev, file]));
  }, [state?.sessionFile]);

  const handlePickFile = useCallback((relPath: string, _name: string) => {
    composerRef.current?.insertText(`@${relPath}`);
  }, []);

  const handlePickDir = useCallback((path: string) => {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized) composerRef.current?.insertText(`@${normalized}/`);
    setFolderPickerOpen(false);
  }, []);

  const saveMessageAsMemory = useCallback(
    async (message: RenderedMessage) => {
      const projectId = state?.project?.id;
      if (!projectId) {
        toast("warn", "请先将当前会话加入项目");
        return;
      }
      const content = message.text.trim();
      if (!content) {
        toast("warn", "当前消息没有可保存的文本");
        return;
      }
      try {
        await saveProjectMemory(projectId, {
          content,
          type: "summary",
          pinned: false,
          sourceSessionId: state?.sessionId,
        });
        toast("ok", "消息已保存为项目记忆");
      } catch (error) {
        toast("error", (error as Error).message);
      }
    },
    [state?.project?.id, state?.sessionId, toast],
  );

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
        onCancelQueued={cancelQueued}
        onEditQueued={editQueued}
        onSaveMemory={saveMessageAsMemory}
        canSaveMemory={Boolean(state?.project?.id)}
      />
      <LongTaskQueue
        tasks={state?.longTasks ?? []}
        onCancel={(id) => sendMessage({ type: "cancel_long_task", id })}
        onClear={() => sendMessage({ type: "clear_long_tasks" })}
      />
      <Composer
        ref={composerRef}
        isStreaming={state?.isStreaming ?? false}
        model={state?.model ?? null}
        models={state?.availableModels ?? []}
        activeAgentId={state?.activeAgent?.id}
        agents={agents}
        onSend={send}
        onPickFolder={() => setFolderPickerOpen(true)}
        onSteer={steer}
        onAbort={() => sendMessage({ type: "abort" })}
        onSetModel={(provider, id) => sendMessage({ type: "set_model", provider, id })}
        onSetAgent={(id) => {
          void setActiveAgent(id).catch((e) => toast("error", e.message));
        }}
        onError={(m) => toast("error", m)}
        oneShot={oneShot}
        onTaskModeChange={(next) => setOneShot(next)}
        goalText={goalText}
        onGoalTextChange={setGoalText}
        onSaveGoalText={(goal) =>
          void setGoals(goalsEnabled, goal)
            .then((v) => {
              setGoalText(v.goal);
            })
            .catch((e) => toast("error", e.message))
        }
      />
    </>
  );

  return (
    <div
      className="app"
      style={{ "--right-panel-width": `${rightPanelWidth}px` } as CSSProperties}
    >
      {bootStatus.state !== "ready" && (
        <div className="boot-overlay" role="status" aria-live="polite">
          <div className="boot-card">
            <div className="boot-indicator" aria-hidden="true" />
            <strong>{bootStatus.state === "error" ? "AI 引擎初始化失败" : "AI 引擎初始化中"}</strong>
            <span>{bootStatus.message || "正在准备本地运行环境"}</span>
            {bootStatus.state === "error" && (
              <button className="btn primary" onClick={() => void retryInitialization()}>
                重试
              </button>
            )}
          </div>
        </div>
      )}
      {sidebarOpen ? (
        <Sidebar
          state={state}
          style={{ width: sidebarWidth, minWidth: sidebarWidth, flexBasis: sidebarWidth }}
          sessions={sessions}
          projects={projects}
          selectedProjectId={selectedProjectId}
          connected={connected}
          wechatStatus={wechatStatus}
          theme={theme}
          onToggleTheme={toggleTheme}
          activePanel={panel}
          onPanel={setPanel}
          onNewSession={newSession}
          onSwitchSession={switchSession}
          onDeleteSession={handleDeleteSession}
          onArchiveSession={handleArchiveSession}
          onSelectProject={setSelectedProjectId}
          onManageProjects={() => setPanel("projects")}
          onNewProjectSession={newProjectSession}
          onDeleteProject={(projectId) => {
            setSelectedProjectId((cur) => (cur === projectId ? null : cur));
            void deleteProject(projectId);
          }}
          onArchiveProject={(projectId) => {
            setSelectedProjectId((cur) => (cur === projectId ? null : cur));
            void archiveProject(projectId);
          }}
          onAssignSession={(file, projectId) => void assignSession(file, projectId)}
          onPickFile={handlePickFile}
          onPickDir={handlePickDir}
          onPreviewFile={(path, name, root) => setPreview({ path, name, root })}
          onCollapse={() => setSidebarOpen(false)}
          onRefreshSessions={() => void refreshSessions()}
          onSetThinking={(level) => sendMessage({ type: "set_thinking", level })}
        />
      ) : (
        <button className="sidebar-rail" title="展开侧栏" onClick={() => setSidebarOpen(true)}>
          »
        </button>
      )}
      {sidebarOpen && (
        <div
          className="pane-resizer sidebar-resizer"
          role="separator"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          onPointerDown={(event) => startResize("sidebar", event)}
          title="拖动调整侧栏宽度"
        />
      )}
      <div className={`main ${isEmpty ? "has-empty" : ""}`}>
        <div className="main-header">
          <span className="main-title">Pi Studio</span>
          <span className="version-badge">v{import.meta.env.VITE_APP_VERSION}</span>
          {state?.piVersion && <span className="version-badge">Pi v{state.piVersion}</span>}
          <span className="main-sub">
            {state?.model?.displayName ?? ""}
            {" · "}{projects.find((p) => p.id === selectedProjectId)?.name ?? "临时对话"}
          </span>
        </div>
        <div className="session-tabs" role="tablist" aria-label="打开的会话">
          {openTabFiles.map((file) => {
            const session = sessions.find((s) => s.file === file);
            if (!session) return null;
            const active = state?.sessionFile === session.file;
            return (
              <button
                key={session.id}
                className={`session-tab${active ? " active" : ""}`}
                onClick={() => switchSession(session.file)}
                role="tab"
                aria-selected={active}
                title={session.file}
              >
                <span className="session-tab-name">{session.name || session.firstMessage || "新会话"}</span>
                <span className="session-tab-count">{session.messageCount}</span>
                <span
                  role="button"
                  className="session-tab-close"
                  title="关闭标签页"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(session.file);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
          <button className="session-tab session-tab-new" onClick={newSession} title="新建会话">
            ＋
          </button>
        </div>
        {isEmpty ? <div className="main-center">{mainContent}</div> : mainContent}
      </div>
      {(panel || preview) && (
        <div
          className="pane-resizer right-resizer"
          role="separator"
          aria-label="调整右侧面板宽度"
          aria-orientation="vertical"
          onPointerDown={(event) => startResize("right", event)}
          title="拖动调整右侧面板宽度"
        />
      )}
      {panel && (
        <Suspense fallback={<div className="right-panel panel-loading">加载面板中…</div>}>
          {panel === "mcp" && (
            <div className="right-panel">
              <McpPanel mcp={state?.mcp ?? null} onCommand={sendToolCommand} onClose={() => setPanel(null)} onToast={toast} />
            </div>
          )}
          {panel === "models" && (
            <div className="right-panel">
              <ModelsPanel
                current={state?.model ? { provider: state.model.provider, id: state.model.id } : null}
                onSelect={(provider, id) => sendMessage({ type: "set_model", provider, id })}
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
          {panel === "schedules" && (
            <div className="right-panel">
              <SchedulesPanel agents={agents} onClose={() => setPanel(null)} onToast={toast} />
            </div>
          )}
          {panel === "wechat" && (
            <div className="right-panel wechat-right-panel">
              <WechatPanel status={wechatStatus} qr={wechatQr} logs={wechatLogs} onCommand={sendWechatCommand} onClose={() => setPanel(null)} />
            </div>
          )}
          {panel === "projects" && (
            <div className="right-panel">
              <ProjectsPanel
                projects={projects}
                currentSessionFile={state?.sessionFile}
                currentProjectId={state?.project?.id ?? null}
                onProjectsChange={setProjects}
                onStateRefresh={() => void refreshSessions()}
                onSessionSelect={switchSession}
                onClose={() => setPanel(null)}
                onToast={toast}
              />
            </div>
          )}
          {panel === "archived" && (
            <div className="right-panel">
              <ArchivedSessionsPanel
                sessions={archivedSessions}
                onRestore={(file) => void handleRestoreArchived(file)}
                onDelete={(file) => void handleDeleteArchived(file)}
                onClose={() => setPanel(null)}
              />
            </div>
          )}
        </Suspense>
      )}
      {preview && (
        <Suspense fallback={<div className="right-panel panel-loading">加载面板中…</div>}>
          <FilePreview
            file={preview}
            onClose={() => setPreview(null)}
            onInsertRef={(path) => handlePickFile(path, path.split("/").pop() ?? path)}
          />
        </Suspense>
      )}
      {folderPickerOpen && (
        <DirPicker
          title="选择要引用的文件夹"
          initialPath={state?.cwd}
          onSelect={handlePickDir}
          onClose={() => setFolderPickerOpen(false)}
        />
      )}
      {questions.length > 0 && (
        <div className="ask-user-backdrop" role="dialog" aria-modal="true" aria-label="Agent 澄清问题">
          <div className="ask-user-card ask-user-list-card">
            {questions.map((question) => (
              <div className="ask-user-item" key={question.id}>
                <div className="ask-user-kicker">
                  {question.sessionName ? `会话 ${question.sessionName}` : "Agent 需要确认"}
                </div>
                <div className="ask-user-question">
                  <Markdown text={question.question} />
                </div>
                {question.options.length > 0 && (
                  <div className="ask-user-options">
                    {question.options.map((option, index) => (
                      <button
                        key={`${option.label}-${index}`}
                        className="ask-user-option"
                        onClick={() => answerQuestion(question.id, option.label)}
                      >
                        <strong>{option.label}</strong>
                        {option.description && <small>{option.description}</small>}
                      </button>
                    ))}
                  </div>
                )}
                <div className="ask-user-freeform">
                  <span className="ask-user-or">或手动输入</span>
                  <input
                    autoFocus
                    value={questionAnswers[question.id] ?? ""}
                    placeholder="输入你的回答…"
                    onChange={(e) => setQuestionAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") answerQuestion(question.id, questionAnswers[question.id] ?? "");
                    }}
                  />
                  <button
                    className="btn primary"
                    disabled={!(questionAnswers[question.id] ?? "").trim()}
                    onClick={() => answerQuestion(question.id, questionAnswers[question.id] ?? "")}
                  >
                    提交
                  </button>
                </div>
              </div>
            ))}
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
