// Shared protocol types between server and client.

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ClientMessage {
  id: string;
  role: "user" | "assistant" | "toolResult";
  text: string;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
  attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
  name: string;
  path: string; // relative to session cwd
  mediaType: string;
  size: number;
  data?: string; // base64, only for small images
}

export interface ModelInfo {
  provider: string;
  id: string;
  displayName: string;
  thinking: string[]; // supported thinking levels
  kind?: string;
  contextWindow?: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  prompt: string;
  memory?: string;
  builtIn?: boolean;
}

export interface SessionMeta {
  id: string;
  file: string;
  name?: string;
  createdAt?: number;
  messageCount: number;
  firstMessage?: string;
}

export interface McpServerStatus {
  name: string;
  status: string;
  toolCount: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
  disabled: boolean;
}

export interface McpStatusSnapshot {
  version: number;
  servers: McpServerStatus[];
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
}

export type WechatStatusPhase =
  | "idle"
  | "connecting"
  | "qr"
  | "scanned"
  | "expired"
  | "connected"
  | "error";

export interface WechatStatus {
  phase: WechatStatusPhase;
  message?: string;
  account?: string;
  timestamp: number;
}

export interface WechatQr {
  url: string;
  data: string;
  timestamp: number;
}

export interface WechatLogEntry {
  id: string;
  direction: "in" | "out" | "system";
  text: string;
  timestamp: number;
}

export type WechatCommandAction = "connect" | "reconnect" | "disconnect";

export interface AppState {
  messages: ClientMessage[];
  /** Pi SDK (pi-coding-agent) version, e.g. "0.83.0". */
  piVersion?: string;
  model?: ModelInfo | null;
  thinkingLevel: string;
  isStreaming: boolean;
  cwd: string;
  availableModels: ModelInfo[];
  activeAgent?: AgentProfile;
  mcp?: McpStatusSnapshot | null;
  sessionFile?: string;
  sessionId?: string;
}

// ---- Client -> Server WebSocket messages ----
export type ClientWsMessage =
  | { type: "prompt"; text: string; attachments?: AttachmentInfo[]; refs?: string[] }
  | { type: "steer"; text: string }
  | { type: "followUp"; text: string }
  | { type: "abort" }
  | { type: "new_session" }
  | { type: "list_sessions" }
  | { type: "switch_session"; file: string }
  | { type: "set_model"; provider: string; id: string }
  | { type: "set_thinking"; level: string }
  | { type: "mcp_command"; command: string }
  | { type: "command"; command: string }
  | { type: "switch_workspace"; path: string }
  | { type: "add_workspace"; path: string }
  | { type: "ask_user_answer"; id: string; answer: string }
  | { type: "wechat_command"; action: WechatCommandAction };

// ---- Server -> Client WebSocket messages ----
export type ServerWsMessage =
  | { type: "ready"; state: AppState }
  | { type: "state"; state: AppState }
  | { type: "event"; event: unknown }
  | { type: "mcp_status"; snapshot: McpStatusSnapshot }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "workspaces"; workspaces: WorkspaceInfo[] }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "error"; message: string }
  | { type: "ask_user"; question: AskUserQuestion }
  | { type: "wechat_status"; status: WechatStatus }
  | { type: "wechat_qr"; qr: WechatQr }
  | { type: "wechat_log"; entry: WechatLogEntry };

export interface AskUserQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowFreeform: boolean;
}

export interface WorkspaceInfo {
  path: string;
  name: string;
  current: boolean;
}

export interface WorkspaceFileContent {
  name: string;
  path: string;
  size: number;
  mime: string;
  isBinary: boolean;
  /** UTF-8 text content, or a base64 data URL for images. */
  content?: string;
  /** True when the content was truncated to the preview limit. */
  truncated?: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
  args?: string;
  group: "session" | "mcp" | "model" | "system";
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export interface CatalogModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  available: boolean;
}

export interface ModelCatalogEntry {
  provider: string;
  displayName?: string;
  /** Registered in ~/.pi/agent/models.json (custom), vs built-in provider. */
  isCustom: boolean;
  authConfigured: boolean;
  authSource?: string;
  models: CatalogModel[];
}
