import { useCallback, useEffect, useRef, useState } from "react";
import {
  PiSocket,
  getGoals,
  getSubagents,
  listAgents,
  listProjects,
  retryBoot,
  setSubagents,
} from "../api";
import type {
  AgentProfile,
  AppState,
  AskUserQuestion,
  AttachmentInfo,
  ClientWsMessage,
  McpStatusSnapshot,
  ProjectSummary,
  SessionMeta,
  WechatCommandAction,
  WechatLogEntry,
  WechatQr,
  WechatStatus,
  WorkspaceInfo,
} from "../types";
import {
  buildOneShotGoal,
  emptyLiveSnapshot,
  formatResult,
  sessionKey,
  type LiveSnapshot,
  type LiveTool,
  type QueuedItem,
  type Toast,
} from "../types-app";

export interface UseLiveSocketOptions {
  toast: (level: Toast["level"], message: string) => void;
  setSessions: (sessions: SessionMeta[]) => void;
  setWorkspaces: (workspaces: WorkspaceInfo[]) => void;
  setProjects: (projects: ProjectSummary[]) => void;
}

export type BootStatus = { state: "booting" | "error" | "ready"; message?: string };

/**
 * Owns the PiSocket lifecycle, the server state (`AppState`), the live-streaming
 * state machine (per-session drafts reconciled by server snapshots) and every
 * WebSocket command the UI can issue.
 */
export function useLiveSocket(options: UseLiveSocketOptions) {
  const { toast, setSessions, setWorkspaces, setProjects } = options;

  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [bootStatus, setBootStatus] = useState<BootStatus>({ state: "booting" });
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [liveText, setLiveText] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [queued, setQueued] = useState<QueuedItem[] | null>(null);
  const [subagentsEnabled, setSubagentsEnabled] = useState(false);
  const [goalsEnabled, setGoalsEnabled] = useState(false);
  const [goalText, setGoalText] = useState("");
  const [wechatStatus, setWechatStatus] = useState<WechatStatus | null>(null);
  const [wechatQr, setWechatQr] = useState<WechatQr | null>(null);
  const [wechatLogs, setWechatLogs] = useState<WechatLogEntry[]>([]);
  const [oneShot, setOneShot] = useState<{ subagents: boolean; goals: boolean }>({ subagents: false, goals: false });
  const [questions, setQuestions] = useState<AskUserQuestion[]>([]);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});

  const socketRef = useRef<PiSocket | null>(null);
  const activeSessionKeyRef = useRef("unknown");
  const liveBySessionRef = useRef(new Map<string, LiveSnapshot>());
  const restoreRef = useRef<{ subagents: { enabled: boolean } | null }>({ subagents: null });
  const subagentsEnabledRef = useRef(subagentsEnabled);
  subagentsEnabledRef.current = subagentsEnabled;
  const goalTextRef = useRef(goalText);
  goalTextRef.current = goalText;
  const oneShotRef = useRef(oneShot);
  oneShotRef.current = oneShot;

  const sendMessage = useCallback((msg: ClientWsMessage) => {
    socketRef.current?.send(msg);
  }, []);

  const syncLive = useCallback((snapshot: LiveSnapshot) => {
    setLiveText(snapshot.text);
    setLiveThinking(snapshot.thinking);
    setLiveTools(snapshot.tools);
    setQueued(snapshot.queued);
  }, []);

  const restoreOneShot = useCallback(() => {
    const restore = restoreRef.current;
    if (!restore.subagents) return;
    const previous = restore.subagents;
    restore.subagents = null;
    setSubagentsEnabled(previous.enabled);
    void setSubagents(previous.enabled).catch((e) => toast("error", e.message));
  }, [toast]);

  const handleEvent = useCallback(
    (event: unknown) => {
      const e = event as {
        type: string;
        sessionId?: string;
        sessionFile?: string;
        assistantMessageEvent?: { type: string; delta?: string; thinking?: string };
        toolName?: string;
        toolCallId?: string;
        args?: unknown;
        isError?: boolean;
        result?: unknown;
        content?: unknown;
        partialResult?: unknown;
        steering?: string[];
        followUp?: string[];
      };
      const key = sessionKey(e.sessionId);
      const activeKey = activeSessionKeyRef.current;
      const current = liveBySessionRef.current.get(key) ?? emptyLiveSnapshot();
      const next: LiveSnapshot = {
        text: current.text,
        thinking: current.thinking,
        tools: [...current.tools],
        queued: current.queued ? { ...current.queued } : null,
      };

      switch (e.type) {
        case "message_update": {
          const a = e.assistantMessageEvent;
          if (a?.type === "text_delta") next.text += a.delta ?? "";
          else if (a?.type === "thinking_delta") next.thinking += a.delta ?? "";
          break;
        }
        case "message_end":
          next.text = "";
          next.thinking = "";
          next.tools = [];
          break;
        case "tool_execution_start": {
          next.tools.push({
            key: e.toolCallId ?? (Date.now() + "-" + Math.random().toString(36).slice(2, 6)),
            name: e.toolName ?? "tool",
            status: "running",
            args: formatResult(e.args),
          });
          break;
        }
        case "tool_execution_update": {
          const toolKey = e.toolCallId;
          const partial = e.partialResult ?? e.content;
          if (partial !== undefined) {
            const targetIndex = toolKey
              ? next.tools.findIndex((tool) => tool.key === toolKey)
              : next.tools.length - 1;
            if (targetIndex >= 0) next.tools[targetIndex] = { ...next.tools[targetIndex], output: formatResult(partial) };
          }
          break;
        }
        case "tool_execution_end": {
          const toolKey = e.toolCallId;
          const targetIndex = toolKey
            ? next.tools.findIndex((tool) => tool.key === toolKey)
            : next.tools.length - 1;
          if (targetIndex >= 0) {
            next.tools[targetIndex] = {
              ...next.tools[targetIndex],
              status: e.isError ? "error" : "done",
              output: formatResult(e.result),
            };
          }
          break;
        }
        case "queue_update":
          next.queued = [
            ...(e.steering ?? []).map((text) => ({ kind: "steer" as const, text })),
            ...(e.followUp ?? []).map((text) => ({ kind: "followUp" as const, text })),
          ];
          break;
        case "agent_end":
        case "agent_settled":
          liveBySessionRef.current.set(key, emptyLiveSnapshot());
          if (key === activeKey) {
            restoreOneShot();
            syncLive(emptyLiveSnapshot());
          }
          return;
        case "auto_retry_start":
          if (key === activeKey) toast("warn", "网络波动，正在自动重试…");
          return;
        case "compaction_start":
          if (key === activeKey) toast("info", "正在压缩对话历史…");
          return;
      }

      liveBySessionRef.current.set(key, next);
      if (key === activeKey) syncLive(next);
    },
    [restoreOneShot, syncLive, toast],
  );

  const applyState = useCallback(
    (s: AppState) => {
      const key = sessionKey(s.sessionId);
      activeSessionKeyRef.current = key;
      setState(s);
      if (!s.isStreaming) {
        liveBySessionRef.current.delete(key);
        syncLive(emptyLiveSnapshot());
        return;
      }
      const snapshot = liveBySessionRef.current.get(key) ?? emptyLiveSnapshot();
      liveBySessionRef.current.set(key, snapshot);
      syncLive(snapshot);
    },
    [syncLive],
  );

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
          void listProjects().then(setProjects).catch(() => {});
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
          setQuestions((prev) => (prev.some((q) => q.id === msg.question.id) ? prev : [...prev, msg.question]));
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
    let deepLinkTimer: number | undefined;
    if (deepLink) {
      deepLinkTimer = window.setTimeout(() => socket.send({ type: "switch_session", file: deepLink }), 800);
    }
    return () => {
      if (deepLinkTimer !== undefined) window.clearTimeout(deepLinkTimer);
      off();
      socket.close();
    };
    // All referenced option callbacks/setters are stable (useState setters / useCallback([])).
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

  const send = useCallback(
    async (text: string, attachments?: AttachmentInfo[], refs?: string[]) => {
      const one = oneShotRef.current;
      const longGoal = one.goals ? buildOneShotGoal(text, goalTextRef.current) : undefined;
      try {
        if (one.subagents && !subagentsEnabledRef.current) {
          restoreRef.current.subagents = { enabled: subagentsEnabledRef.current };
          await setSubagents(true);
          setSubagentsEnabled(true);
        }
      } catch (e) {
        toast("error", (e as Error).message);
        return;
      }
      if (one.subagents || one.goals) setOneShot({ subagents: false, goals: false });
      socketRef.current?.send({ type: "prompt", text, attachments, refs, longGoal });
    },
    [toast],
  );

  const steer = useCallback((text: string) => {
    if (!text.trim()) return;
    socketRef.current?.send({ type: "steer", text: text.trim() });
  }, []);

  const cancelQueued = useCallback((kind: "steer" | "followUp", text: string) => {
    socketRef.current?.send({ type: "cancel_queue_item", kind, text });
  }, []);

  const editQueued = useCallback((kind: "steer" | "followUp", oldText: string, newText: string) => {
    const text = newText.trim();
    if (!text || text === oldText) return;
    socketRef.current?.send({ type: "edit_queue_item", kind, oldText, newText: text });
  }, []);

  const sendToolCommand = useCallback((command: string) => {
    socketRef.current?.send({ type: "mcp_command", command });
  }, []);

  const sendWechatCommand = useCallback((action: WechatCommandAction) => {
    socketRef.current?.send({ type: "wechat_command", action });
  }, []);

  const answerQuestion = useCallback((id: string, answer: string) => {
    const text = answer.trim();
    if (!text) return;
    socketRef.current?.send({ type: "ask_user_answer", id, answer: text });
    setQuestions((prev) => prev.filter((q) => q.id !== id));
    setQuestionAnswers((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return {
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
    subagentsEnabled,
    setSubagentsEnabled,
    goalsEnabled,
    setGoalsEnabled,
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
  };
}
