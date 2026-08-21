import type { AgentProfile, AppState, ArchivedSession, AttachmentInfo, CommandInfo, FileEntry, ModelCatalogEntry, ParsedDoc, Project, ProjectDocument, ProjectMemory, ProjectMemoryType, ProjectSummary, ProjectSearchResult, SessionMeta, ServerWsMessage, ClientWsMessage, WorkspaceInfo, WorkspaceFileContent, SkillSummary } from "./types";
import type { ScheduledTask } from "./types";
import { httpFetch, httpJson } from "./http";

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
  return httpFetch(url, init, { token: authToken, sameOriginCredentials: true });
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
  return httpJson<T>(url, init, { token: authToken, sameOriginCredentials: true });
}

export async function getState(): Promise<AppState> {
  return json<AppState>("/api/state");
}

export async function listSessions(): Promise<SessionMeta[]> {
  return json<SessionMeta[]>("/api/sessions");
}

export async function deleteSession(file: string): Promise<{ ok: boolean; activeFile?: string }> {
  return json<{ ok: boolean; activeFile?: string }>("/api/sessions", {
    method: "DELETE",
    body: JSON.stringify({ file }),
  });
}

export async function listArchivedSessions(): Promise<ArchivedSession[]> {
  return json<ArchivedSession[]>("/api/archived-sessions");
}

export async function archiveSession(file: string): Promise<{ ok: boolean; activeFile?: string }> {
  return json<{ ok: boolean; activeFile?: string }>("/api/sessions/archive", {
    method: "POST",
    body: JSON.stringify({ file }),
  });
}

export async function restoreSession(file: string): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>("/api/sessions/restore", {
    method: "POST",
    body: JSON.stringify({ file }),
  });
}

export async function deleteArchivedSession(file: string): Promise<{ ok: boolean; activeFile?: string }> {
  return json<{ ok: boolean; activeFile?: string }>("/api/archived-sessions", {
    method: "DELETE",
    body: JSON.stringify({ file }),
  });
}

// ------------------------------------------------------------ projects

export async function listProjects(): Promise<ProjectSummary[]> {
  return json<ProjectSummary[]>("/api/projects");
}

export async function getProject(id: string): Promise<Project> {
  return json<Project>(`/api/projects/${encodeURIComponent(id)}`);
}

export async function createProject(input: { name: string; description?: string; workspacePaths?: string[]; workspacePath?: string; mainWorkspacePath?: string | null; instructions?: string }): Promise<Project> {
  return json<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateProject(id: string, patch: { name?: string; description?: string; workspacePaths?: string[] | null; workspacePath?: string | null; mainWorkspacePath?: string | null; instructions?: string }): Promise<Project> {
  return json<Project>(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function removeProject(id: string): Promise<void> {
  await json(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listArchivedProjects(): Promise<ProjectSummary[]> {
  return json<ProjectSummary[]>("/api/projects/archived");
}

export async function archiveProject(id: string): Promise<void> {
  await json(`/api/projects/${encodeURIComponent(id)}/archive`, { method: "POST" });
}

export async function restoreProject(id: string): Promise<void> {
  await json(`/api/projects/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

export async function assignSessionToProject(projectId: string, file: string): Promise<ProjectSummary | null> {
  return json<ProjectSummary | null>(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: "POST",
    body: JSON.stringify({ file }),
  });
}

export async function removeSessionFromProject(projectId: string, file: string): Promise<void> {
  await json(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: "DELETE",
    body: JSON.stringify({ file }),
  });
}

export async function saveProjectMemory(projectId: string, input: { id?: string; content: string; type?: ProjectMemoryType; pinned?: boolean; sourceSessionId?: string }): Promise<ProjectMemory> {
  return json<ProjectMemory>(`/api/projects/${encodeURIComponent(projectId)}/memories`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function removeProjectMemory(projectId: string, memoryId: string): Promise<void> {
  await json(`/api/projects/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
}

export async function searchProject(projectId: string, query: string): Promise<ProjectSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  return json<ProjectSearchResult[]>(`/api/projects/${encodeURIComponent(projectId)}/search?${params}`);
}

export async function addProjectDocument(projectId: string, input: { path: string; name?: string; summary?: string }): Promise<ProjectDocument> {
  return json<ProjectDocument>(`/api/projects/${encodeURIComponent(projectId)}/documents`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function removeProjectDocument(projectId: string, documentId: string): Promise<void> {
  await json(`/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
}

export async function uploadFiles(files: File[]): Promise<AttachmentInfo[]> {
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await httpFetch("/api/upload", { method: "POST", body: fd }, { token: authToken, sameOriginCredentials: true });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  const data = (await res.json()) as { files: AttachmentInfo[] };
  return data.files;
}

export async function addMcpServer(name: string, config: Record<string, unknown>): Promise<void> {
  await json("/api/mcp/servers", {
    method: "POST",
    body: JSON.stringify({ name, config }),
  });
}

export async function removeMcpServer(name: string): Promise<void> {
  await json(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function addMcpServersBatch(servers: Record<string, unknown>): Promise<void> {
  await json("/api/mcp/servers/batch", {
    method: "POST",
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
    body: JSON.stringify({ path }),
  });
}

export async function switchWorkspace(path: string): Promise<WorkspaceInfo[]> {
  return json<WorkspaceInfo[]>("/api/workspaces/switch", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function listWorkspaceFiles(path: string, root?: string): Promise<FileEntry[]> {
  const q = new URLSearchParams({ path });
  if (root) q.set("root", root);
  const r = await json<{ entries: FileEntry[] }>(`/api/workspace/files?${q}`);
  return r.entries;
}

export async function moveWorkspaceFile(source: string, destination: string, root?: string): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>("/api/workspace/files/move", {
    method: "POST",
    body: JSON.stringify({ source, destination, ...(root ? { root } : {}) }),
  });
}

export async function readWorkspaceFile(path: string, root?: string): Promise<WorkspaceFileContent> {
  const q = new URLSearchParams({ path });
  if (root) q.set("root", root);
  return json<WorkspaceFileContent>(`/api/workspace/file?${q}`);
}

export async function parseWorkspaceFile(path: string, root?: string): Promise<ParsedDoc> {
  return json<ParsedDoc>("/api/workspace/file/parse", {
    method: "POST",
    body: JSON.stringify({ path, ...(root ? { root } : {}) }),
  });
}

// ------------------------------------------------------------ model mgmt

export async function listModels(): Promise<ModelCatalogEntry[]> {
  return json<ModelCatalogEntry[]>("/api/models");
}

export async function getModelsConfig(): Promise<Record<string, unknown>> {
  return json<Record<string, unknown>>("/api/models/config");
}

export async function refreshModels(): Promise<{ ok: boolean; errors: string[]; catalog: ModelCatalogEntry[] }> {
  return json("/api/models/refresh", { method: "POST" });
}

export async function registerModelProvider(name: string, config: Record<string, unknown>): Promise<{ ok: boolean; name: string; errors: string[] }> {
  return json("/api/models/register", {
    method: "POST",
    body: JSON.stringify({ name, config }),
  });
}

export async function unregisterModelProvider(name: string): Promise<{ ok: boolean; name: string; errors: string[] }> {
  return json("/api/models/unregister", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function setProviderApiKey(provider: string, apiKey: string): Promise<void> {
  await json("/api/models/api-key", {
    method: "POST",
    body: JSON.stringify({ provider, apiKey }),
  });
}

export async function removeProviderApiKey(provider: string): Promise<void> {
  await json(`/api/models/api-key?provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
}
export const listSchedules = () => json<ScheduledTask[]>("/api/schedules");
export const saveSchedule = (task: Partial<ScheduledTask>) => json<ScheduledTask>("/api/schedules", { method:"POST", body:JSON.stringify(task) });
export const runSchedule = (id:string) => json(`/api/schedules/${encodeURIComponent(id)}/run`, {method:"POST"});
export const setScheduleEnabled = (id:string, enabled:boolean) => json<ScheduledTask>(`/api/schedules/${encodeURIComponent(id)}/enabled`, {method:"POST",body:JSON.stringify({enabled})});
export const removeSchedule = (id:string) => json(`/api/schedules/${encodeURIComponent(id)}`,{method:"DELETE"});
export const getSubagents = () => json<{enabled:boolean}>("/api/subagents");
export const setSubagents = (enabled:boolean) => json<{enabled:boolean}>("/api/subagents",{method:"POST",body:JSON.stringify({enabled})});
export const getGoals = () => json<{enabled:boolean;goal:string}>("/api/goals");
export const setGoals = (enabled:boolean, goal:string) => json<{enabled:boolean;goal:string}>("/api/goals",{method:"POST",body:JSON.stringify({enabled,goal})});
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
