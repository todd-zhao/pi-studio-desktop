import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerContext } from "./context.ts";
import { AUTH_TOKEN } from "./config.ts";
import { allowedOrigin, requestToken, safeEqual } from "./http/middleware.ts";
import type {
  AppState,
  AskUserQuestion,
  ClientWsMessage,
  McpStatusSnapshot,
  ServerWsMessage,
  SessionMeta,
  WechatLogEntry,
  WechatQr,
  WechatStatus,
  WorkspaceInfo,
} from "@pi-studio/shared";

function send(ws: WebSocket, msg: ServerWsMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function attachWebSocket(ws: WebSocket, ctx: ServerContext): Promise<void> {
  const waitingForBoot = ctx.bootState === "booting";
  if (waitingForBoot) {
    send(ws, { type: "booting", phase: "starting", message: "AI engine initializing" });
  }
  try {
    await ctx.bridgeReady;
  } catch (error) {
    send(ws, { type: "boot_error", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  // Read the bridge from the context *after* readiness so connections that
  // arrived during booting subscribe to the freshly started instance.
  const bridge = ctx.bridge;
  if (!waitingForBoot) {
    send(ws, {
      type: "ready",
      state: bridge.getState(),
      sessions: ctx.initialSessions,
      workspaces: ctx.initialWorkspaces,
    });
  }

  const onState = (state: AppState) => send(ws, { type: "state", state });
  const onEvent = (event: unknown) => send(ws, { type: "event", event });
  const onMcp = (snapshot: McpStatusSnapshot) => send(ws, { type: "mcp_status", snapshot });
  const onSessions = (sessions: SessionMeta[]) => send(ws, { type: "sessions", sessions });
  const onWorkspaces = (workspaces: WorkspaceInfo[]) => send(ws, { type: "workspaces", workspaces });
  const onLog = (level: "info" | "warn" | "error", message: string) => send(ws, { type: "log", level, message });
  const onError = (message: string) => send(ws, { type: "error", message });
  const onAskUser = (question: AskUserQuestion) => send(ws, { type: "ask_user", question });
  const onWechatStatus = (status: WechatStatus) => send(ws, { type: "wechat_status", status });
  const onWechatQr = (qr: WechatQr) => send(ws, { type: "wechat_qr", qr });
  const onWechatLog = (entry: WechatLogEntry) => send(ws, { type: "wechat_log", entry });

  bridge.on("state", onState);
  bridge.on("event", onEvent);
  bridge.on("mcp_status", onMcp);
  bridge.on("sessions", onSessions);
  bridge.on("workspaces", onWorkspaces);
  bridge.on("log", onLog);
  bridge.on("error", onError);
  bridge.on("ask_user", onAskUser);
  bridge.on("wechat_status", onWechatStatus);
  bridge.on("wechat_qr", onWechatQr);
  bridge.on("wechat_log", onWechatLog);

  ws.on("close", () => {
    bridge.off("state", onState);
    bridge.off("event", onEvent);
    bridge.off("mcp_status", onMcp);
    bridge.off("sessions", onSessions);
    bridge.off("workspaces", onWorkspaces);
    bridge.off("log", onLog);
    bridge.off("error", onError);
    bridge.off("ask_user", onAskUser);
    bridge.off("wechat_status", onWechatStatus);
    bridge.off("wechat_qr", onWechatQr);
    bridge.off("wechat_log", onWechatLog);
  });

  ws.on("message", (raw) => {
    let msg: ClientWsMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientWsMessage;
    } catch {
      return;
    }
    void handleClientMessage(ws, msg, ctx);
  });
}

async function handleClientMessage(ws: WebSocket, msg: ClientWsMessage, ctx: ServerContext): Promise<void> {
  const { bridge } = ctx;
  try {
    switch (msg.type) {
      case "prompt": {
        send(ws, { type: "log", level: "info", message: "已发送" });
        if (msg.longGoal?.trim()) {
          await bridge.enqueueLongTask(msg.text, msg.longGoal, msg.attachments, msg.refs);
        } else {
          await bridge.prompt(msg.text, msg.attachments, msg.refs);
        }
        break;
      }
      case "steer":
        await bridge.steer(msg.text);
        break;
      case "followUp":
        await bridge.followUp(msg.text);
        break;
      case "cancel_queue_item":
        await bridge.cancelQueueItem(msg.kind, msg.text);
        break;
      case "edit_queue_item":
        await bridge.editQueueItem(msg.kind, msg.oldText, msg.newText);
        break;
      case "abort":
        await bridge.abort();
        break;
      case "cancel_long_task":
        bridge.cancelLongTask(msg.id);
        break;
      case "clear_long_tasks":
        bridge.clearLongTasks();
        break;
      case "new_session":
        await bridge.newSession(msg.projectId);
        break;
      case "list_sessions": {
        const sessions = await bridge.listSessions();
        send(ws, { type: "sessions", sessions });
        break;
      }
      case "switch_session":
        await bridge.switchSession(msg.file);
        break;
      case "set_model":
        await bridge.setModel(msg.provider, msg.id);
        break;
      case "set_thinking":
        await bridge.setThinking(msg.level);
        break;
      case "mcp_command":
        await bridge.runMcpCommand(msg.command);
        break;
      case "command": {
        const result = await bridge.runCommand(msg.command);
        send(ws, { type: "log", level: "info", message: result });
        break;
      }
      case "switch_workspace":
        await bridge.switchWorkspace(msg.path);
        break;
      case "add_workspace":
        bridge.addWorkspace(msg.path);
        break;
      case "ask_user_answer":
        bridge.answerUserQuestion(msg.id, msg.answer);
        break;
      case "wechat_command":
        await bridge.runWechatCommand(msg.action);
        break;
    }
  } catch (e) {
    send(ws, { type: "error", message: (e as Error).message });
  }
}

/**
 * Attach the WebSocket server to the HTTP server and wire per-client bridge
 * event subscriptions. Also registers the shared broadcast function on the
 * context so startup code can push messages to every connected client.
 */
export function createWsServer(server: Server, ctx: ServerContext): void {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient(info, done) {
      const origin = info.origin || undefined;
      const authorized = !AUTH_TOKEN || safeEqual(requestToken(info.req), AUTH_TOKEN);
      if (!allowedOrigin(origin)) {
        done(false, 403, "Forbidden origin");
        return;
      }
      if (!authorized) {
        done(false, 401, "Unauthorized");
        return;
      }
      done(true);
    },
  });

  ctx.broadcast = (msg: ServerWsMessage): void => {
    for (const client of wss.clients) send(client, msg);
  };

  wss.on("connection", (ws) => {
    void attachWebSocket(ws, ctx).catch((error) => {
      send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
    });
  });
}
