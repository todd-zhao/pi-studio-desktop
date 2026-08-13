import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentProfile } from "@pi-studio/shared";
import { containsSensitiveMemory } from "./shared.ts";

export interface AgentStoreDeps {
  agentsFile: string;
  /** Whether the runtime has finished booting (only then can sessions reload). */
  getStarted: () => boolean;
  /** Reload the active session so agent prompt/memory changes take effect. */
  reloadActiveSession: () => Promise<void>;
  pushState: () => void;
}

/**
 * Agent profiles (default + custom) and the active-agent selection, persisted
 * to agents.json under the app-local pi agent directory.
 */
export class AgentStore {
  private agents: AgentProfile[] = [];
  private activeAgentId = "default";

  constructor(private readonly deps: AgentStoreDeps) {}

  private defaultAgent(): AgentProfile {
    return { id: "default", name: "默认助手", description: "不附加额外提示词", prompt: "", memory: "", builtIn: true };
  }

  loadAgents(): void {
    try {
      if (existsSync(this.deps.agentsFile)) {
        const parsed = JSON.parse(readFileSync(this.deps.agentsFile, "utf8")) as { agents?: AgentProfile[]; activeAgentId?: string };
        this.agents = (parsed.agents ?? []).filter((agent) => agent && typeof agent.id === "string" && typeof agent.name === "string" && typeof agent.prompt === "string")
          .map((agent) => ({ ...agent, memory: typeof agent.memory === "string" ? agent.memory : "" }));
        this.activeAgentId = parsed.activeAgentId ?? "default";
      }
    } catch {
      this.agents = [];
      this.activeAgentId = "default";
    }
    if (!this.agents.some((agent) => agent.id === "default")) this.agents.unshift(this.defaultAgent());
    if (!this.agents.some((agent) => agent.id === this.activeAgentId)) this.activeAgentId = "default";
    this.writeAgents();
  }

  private writeAgents(): void {
    writeFileSync(this.deps.agentsFile, JSON.stringify({ agents: this.agents, activeAgentId: this.activeAgentId }, null, 2) + "\n", "utf8");
  }

  listAgents(): AgentProfile[] {
    return this.agents.map((agent) => ({ ...agent }));
  }

  getActiveAgent(): AgentProfile {
    return this.agents.find((agent) => agent.id === this.activeAgentId) ?? this.defaultAgent();
  }

  async saveAgent(agent: Omit<AgentProfile, "builtIn">): Promise<AgentProfile> {
    const name = agent.name.trim();
    if (!name) throw new Error("Agent 名称不能为空");
    const id = agent.id.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("Agent ID 只能包含字母、数字、下划线和连字符");
    const memory = (agent.memory ?? "").trim();
    if (memory.length > 16_000) throw new Error("Agent 长期记忆最多 16,000 个字符");
    if (containsSensitiveMemory(memory)) throw new Error("长期记忆疑似包含密钥、令牌或密码，已拒绝保存");
    if (id === "default") {
      const index = this.agents.findIndex((item) => item.id === "default");
      this.agents[index] = { ...this.defaultAgent(), memory };
      this.writeAgents();
      if (this.deps.getStarted()) await this.deps.reloadActiveSession();
      this.deps.pushState();
      return { ...this.agents[index] };
    }
    const next: AgentProfile = { id, name, description: agent.description.trim(), prompt: agent.prompt.trim(), memory };
    const index = this.agents.findIndex((item) => item.id === id);
    if (index >= 0) this.agents[index] = { ...this.agents[index], ...next };
    else this.agents.push(next);
    this.writeAgents();
    if (id === this.activeAgentId && this.deps.getStarted()) await this.deps.reloadActiveSession();
    this.deps.pushState();
    return { ...(this.agents.find((item) => item.id === id) as AgentProfile) };
  }

  async removeAgent(id: string): Promise<void> {
    if (id === "default") throw new Error("默认助手不能删除");
    const before = this.agents.length;
    this.agents = this.agents.filter((agent) => agent.id !== id);
    if (this.agents.length === before) throw new Error("Agent 不存在");
    if (this.activeAgentId === id) this.activeAgentId = "default";
    this.writeAgents();
    if (this.deps.getStarted()) await this.deps.reloadActiveSession();
    this.deps.pushState();
  }

  async setActiveAgent(id: string): Promise<void> {
    if (!this.agents.some((agent) => agent.id === id)) throw new Error("Agent 不存在");
    this.activeAgentId = id;
    this.writeAgents();
    if (this.deps.getStarted()) await this.deps.reloadActiveSession();
    this.deps.pushState();
  }
}
