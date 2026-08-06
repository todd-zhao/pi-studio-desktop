import type { AgentProfile, AppState, AttachmentInfo, CommandInfo, FileEntry, ModelCatalogEntry, ParsedDoc, SessionMeta, ServerWsMessage, ClientWsMessage, WorkspaceInfo, WorkspaceFileContent, SkillSummary } from "./types";
import type { ScheduledTask } from "./types";

let authToken = "";
try {
  const currentUrl = new URL(window.location.href);
  authToken = currentUrl.searchParams.get("token") ?? sessionStorage.getItem("pi-studio-auth-token") ?? "";
  if (authToken) sessionStorage.setItem("pi-studio-auth-token", authToken);
  if (currentUrl.searchParams.has("token")) {
    currentUrl.searchParams.delete("token");
    history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  }
} catch {
  // Development in a restricted browser context can continue without a token.
}

export function authenticatedUrl(url: string): string {
  if (!authToken) return url;
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set("token", authToken);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
  return fetch(url, { ...init, headers, credentials: "same-origin" });
}

export const WS_URL = (() => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${proto}//${location.host}/ws`);
  if (authToken) url.searchParams.set("token", authToken);
  return url.toString();
})();

export type SocketHandler = (msg: ServerWsMessage) => void;

export class PiSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<SocketHandler>();
  private queue: ClientWsMessage[] = [];
  private closedByUser = false;
  private reconnectTimer: number | null = null;

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      for (const msg of this.queue) ws.send(JSON.stringify(msg));
      this.queue = [];
    };

    ws.onmessage = (ev) => {
      let msg: ServerWsMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerWsMessage;
      } catch {
        return;
      }
      for (const h of this.handlers) h(msg);
    };

    ws.onclose = () => {
      if (!this.closedByUser && !this.reconnectTimer) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.open();
        }, 2000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  send(msg: ClientWsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  on(handler: SocketHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
  }
}

// ------------------------------------------------------------------ REST

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await apiFetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("请求超时，请重试");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getState(): Promise<AppState> {
  return json<AppState>("/api/state");
}

export async function listSessions(): Promise<SessionMeta[]> {
  return json<SessionMeta[]>("/api/sessions");
}

export async function uploadFiles(files: File[]): Promise<AttachmentInfo[]> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await apiFetch("/api/upload", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  const data = (await res.json()) as { files: AttachmentInfo[] };
  return data.files;
}

export async function addMcpServer(name: string, config: Record<string, unknown>): Promise<void> {
  await json("/api/mcp/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config }),
  });
}

export async function removeMcpServer(name: string): Promise<void> {
  await json(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function addMcpServersBatch(servers: Record<string, unknown>): Promise<void> {
  await json("/api/mcp/servers/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ servers }),
  });
}

export async function listDirs(path: string): Promise<FileEntry[]> {
  const q = new URLSearchParams({ path });
  const r = await json<{ entries: FileEntry[] }>(`/api/dirs?${q}`);
  return r.entries;
}

export async function getMcpConfig(): Promise<{ mcpServers: Record<string, unknown> }> {
  return json("/api/mcp/config");
}


export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return json<WorkspaceInfo[]>("/api/workspaces");
}

export async function addWorkspace(path: string): Promise<WorkspaceInfo[]> {
  return json<WorkspaceInfo[]>("/api/workspaces/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export async function switchWorkspace(path: string): Promise<WorkspaceInfo[]> {
  return json<WorkspaceInfo[]>("/api/workspaces/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export async function listWorkspaceFiles(path: string): Promise<FileEntry[]> {
  const q = new URLSearchParams({ path });
  const r = await json<{ entries: FileEntry[] }>(`/api/workspace/files?${q}`);
  return r.entries;
}

export async function readWorkspaceFile(path: string): Promise<WorkspaceFileContent> {
  const q = new URLSearchParams({ path });
  return json<WorkspaceFileContent>(`/api/workspace/file?${q}`);
}

export async function parseWorkspaceFile(path: string): Promise<ParsedDoc> {
  return json<ParsedDoc>("/api/workspace/file/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

// ------------------------------------------------------------ model mgmt

export async function listModels(): Promise<ModelCatalogEntry[]> {
  return json<ModelCatalogEntry[]>("/api/models");
}

export async function getModelsConfig(): Promise<Record<string, unknown>> {
  return json<Record<string, unknown>>("/api/models/config");
}

export async function registerModelProvider(name: string, config: Record<string, unknown>): Promise<{ ok: boolean; name: string; errors: string[] }> {
  return json("/api/models/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config }),
  });
}

export async function unregisterModelProvider(name: string): Promise<{ ok: boolean; name: string; errors: string[] }> {
  return json("/api/models/unregister", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function setProviderApiKey(provider: string, apiKey: string): Promise<void> {
  await json("/api/models/api-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
}

export async function removeProviderApiKey(provider: string): Promise<void> {
  await json(`/api/models/api-key?provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
}
export const listSchedules = () => json<ScheduledTask[]>("/api/schedules");
export const saveSchedule = (task: Partial<ScheduledTask>) => json<ScheduledTask>("/api/schedules", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(task) });
export const runSchedule = (id:string) => json(`/api/schedules/${encodeURIComponent(id)}/run`, {method:"POST"});
export const setScheduleEnabled = (id:string, enabled:boolean) => json<ScheduledTask>(`/api/schedules/${encodeURIComponent(id)}/enabled`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled})});
export const removeSchedule = (id:string) => json(`/api/schedules/${encodeURIComponent(id)}`,{method:"DELETE"});
export const getSubagents = () => json<{enabled:boolean}>("/api/subagents");
export const setSubagents = (enabled:boolean) => json<{enabled:boolean}>("/api/subagents",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled})});
export const getGoals = () => json<{enabled:boolean;goal:string}>("/api/goals");
export const setGoals = (enabled:boolean, goal:string) => json<{enabled:boolean;goal:string}>("/api/goals",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled,goal})});
export const retryBoot = () => json<{ok:boolean;state:string;error?:string}>("/api/runtime/retry", { method: "POST" });

export async function getEnvironment(): Promise<{ home?: string; username?: string }> {
  return json("/api/env");
}

// ------------------------------------------------------------ agents

export async function listAgents(): Promise<{ agents: AgentProfile[]; activeAgentId: string }> {
  return json("/api/agents");
}

export async function saveAgent(agent: Omit<AgentProfile, "builtIn">): Promise<AgentProfile> {
  const result = await json<{ ok: boolean; agent: AgentProfile }>("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agent),
  });
  return result.agent;
}

export async function removeAgent(id: string): Promise<void> {
  await json(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function setActiveAgent(id: string): Promise<AgentProfile> {
  const result = await json<{ ok: boolean; activeAgent: AgentProfile }>("/api/agents/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return result.activeAgent;
}

export async function listCommands(): Promise<CommandInfo[]> {
  const r = await json<{ commands: CommandInfo[] }>("/api/commands");
  return r.commands;
}

export async function listSkills(): Promise<{ directory: string; skills: SkillSummary[] }> {
  return json<{ directory: string; skills: SkillSummary[] }>("/api/skills");
}

export async function addSkill(name: string, description: string, instructions: string): Promise<SkillSummary[]> {
  const r = await json<{ ok: boolean; skills: SkillSummary[] }>("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, instructions }),
  });
  return r.skills;
}

export async function importSkills(files: File[]): Promise<{ imported: string[]; skills: SkillSummary[] }> {
  const fd = new FormData();
  for (const file of files) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    fd.append("files", file, relativePath);
  }
  const r = await json<{ ok: boolean; imported: string[]; skills: SkillSummary[] }>("/api/skills/import", {
    method: "POST",
    body: fd,
  });
  return { imported: r.imported, skills: r.skills };
}

export async function removeSkill(name: string): Promise<SkillSummary[]> {
  const r = await json<{ ok: boolean; skills: SkillSummary[] }>(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
  return r.skills;
}
