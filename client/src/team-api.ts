import { httpFetch, httpJson } from "./http";
export type TeamRole = "owner" | "admin" | "member" | "guest";

export interface TeamUser {
  id: string;
  username: string;
  displayName: string;
  teamId: string;
  teamName: string;
  role: TeamRole;
}

export interface TeamMember {
  id: string;
  username: string;
  displayName: string;
  role: TeamRole;
}

export interface TeamTask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  result_type: string;
  assignee_id: string | null;
  assignee_name?: string;
  creator_name: string;
  due_at?: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
  comment_count?: number;
  artifact_count?: number;
}

export interface TeamComment { id: string; body: string; user_name: string; created_at: number }
export interface TeamArtifact { id: string; version: number; original_name: string; size: number; note: string; uploaded_by: string; uploader_name: string; created_at: number }
export interface TeamEvent { id: string; action: string; detail: string; user_name: string; created_at: number }
export interface TaskDetail { task: TeamTask; comments: TeamComment[]; artifacts: TeamArtifact[]; events: TeamEvent[] }

const URL_KEY = "pi-team-server-url";
const TOKEN_KEY = "pi-team-token";

function defaultTeamServerUrl(): string {
  try {
    const currentUrl = new URL(window.location.href);
    const teamPort = currentUrl.searchParams.get("teamPort");
    if (teamPort) return `http://127.0.0.1:${teamPort}`;
  } catch {
    // Fall back to the default port.
  }
  return "http://127.0.0.1:8790";
}

export const getTeamServerUrl = () => localStorage.getItem(URL_KEY) || defaultTeamServerUrl();
export const getTeamToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const saveTeamConnection = (url: string, token?: string) => {
  localStorage.setItem(URL_KEY, url.replace(/\/+$/, ""));
  if (token !== undefined) token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);
};

async function request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
  return httpJson<T>(path, init, { baseUrl: getTeamServerUrl(), token: getTeamToken(), authenticated });
}

export const teamHealth = () => request<{ ok: boolean; initialized: boolean }>("/api/health", {}, false);
export const teamLogin = (username: string, password: string) => request<{ token: string; user: TeamUser }>("/api/login", { method: "POST", body: JSON.stringify({ username, password }) }, false);
export const teamBootstrap = (input: { teamName: string; username: string; displayName: string; password: string }) => request<{ token: string; user: TeamUser }>("/api/bootstrap", { method: "POST", body: JSON.stringify(input) }, false);
export const acceptTeamInvitation = (input: { code: string; username: string; displayName: string; password: string }) => request<{ token: string; user: TeamUser }>("/api/invitations/accept", { method: "POST", body: JSON.stringify(input) }, false);
export const teamMe = () => request<TeamUser>("/api/me");
export const listTeamMembers = () => request<TeamMember[]>("/api/members");
export const createInvitation = (role: TeamRole = "member") => request<{ code: string; role: TeamRole; expiresAt: number }>("/api/invitations", { method: "POST", body: JSON.stringify({ role }) });
export const updateTeamMemberRole = (id: string, role: Exclude<TeamRole, "owner">) => request<{ ok: true }>(`/api/members/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ role }) });
export const removeTeamMember = (id: string) => request<{ ok: true }>(`/api/members/${encodeURIComponent(id)}`, { method: "DELETE" });
export const listTeamTasks = () => request<TeamTask[]>("/api/tasks");
export const getTeamTask = (id: string) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
export const createTeamTask = (input: { title: string; description: string; assigneeId?: string; resultType: string; priority: string }) => request<TeamTask>("/api/tasks", { method: "POST", body: JSON.stringify(input) });
export const updateTeamTask = (id: string, input: Partial<TeamTask> & { resultType?: string }) => request<TeamTask>(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
export const claimTeamTask = (id: string) => request<TeamTask>(`/api/tasks/${encodeURIComponent(id)}/claim`, { method: "POST" });
export const deleteTeamTask = (id: string) => request<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
export const clearTeamContent = () => request<{ ok: true; removedTasks: number }>("/api/team/content", { method: "DELETE" });
export const addTaskComment = (id: string, body: string) => request<{ id: string; body: string }>(`/api/tasks/${encodeURIComponent(id)}/comments`, { method: "POST", body: JSON.stringify({ body }) });
export const uploadTaskArtifact = (id: string, file: File, note: string) => {
  const data = new FormData(); data.append("file", file); data.append("note", note);
  return request<{ id: string; version: number; name: string }>(`/api/tasks/${encodeURIComponent(id)}/artifacts`, { method: "POST", body: data });
};
export const deleteTaskArtifact = (id: string) => request<{ ok: true }>(`/api/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" });
export async function downloadTaskArtifact(artifact: TeamArtifact): Promise<void> {
  const response = await httpFetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/download`, {}, { baseUrl: getTeamServerUrl(), token: getTeamToken(), timeoutMs: 0 });
  if (!response.ok) throw new Error("下载成果文件失败");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = artifact.original_name; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class TeamSocket {
  private socket: WebSocket | null = null;
  connect(onChange: () => void): () => void {
    const url = new URL(getTeamServerUrl()); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws"; url.searchParams.set("token", getTeamToken());
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => {
      try { const message = JSON.parse(event.data) as { type?: string }; if (message.type === "task_changed") onChange(); } catch { /* ignore */ }
    };
    return () => { this.socket?.close(); this.socket = null; };
  }
}
