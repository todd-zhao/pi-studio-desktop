import { useEffect, useState } from "react";
import { listAgents, removeAgent, saveAgent, setActiveAgent } from "../api";
import type { AgentProfile } from "../types";
import { PanelShell } from "./PanelShell";
import { usePanel } from "../hooks/usePanel";

interface Props {
  activeAgentId?: string;
  onActiveChange: (agent: AgentProfile) => void;
  onAgentsChange: (agents: AgentProfile[]) => void;
  onClose: () => void;
  onToast: (level: "info" | "warn" | "error" | "ok", message: string) => void;
}

const emptyAgent = (): Omit<AgentProfile, "builtIn"> => ({ id: "", name: "", description: "", prompt: "", memory: "" });

export function AgentsPanel({ activeAgentId, onActiveChange, onAgentsChange, onClose, onToast }: Props) {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [editing, setEditing] = useState<Omit<AgentProfile, "builtIn">>(emptyAgent());
  const { busy, run } = usePanel(onToast);

  const refresh = async () => {
    try {
      const result = await listAgents();
      setAgents(result.agents);
      onAgentsChange(result.agents);
    } catch (e) {
      onToast("error", (e as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const edit = (agent: AgentProfile) => {
    setEditing({ id: agent.id, name: agent.name, description: agent.description, prompt: agent.prompt, memory: agent.memory ?? "" });
  };

  const save = () => {
    run(async () => {
      const id = editing.id.trim() || `agent-${Date.now().toString(36)}`;
      await saveAgent({ ...editing, id });
      setEditing(emptyAgent());
      await refresh();
      onToast("ok", "Agent 已保存");
    });
  };

  const activate = (id: string) => {
    run(async () => {
      onActiveChange(await setActiveAgent(id));
      onToast("ok", "已切换 Agent");
    });
  };

  const remove = (agent: AgentProfile) => {
    if (!window.confirm(`确定删除 Agent “${agent.name}”吗？`)) return;
    run(async () => {
      await removeAgent(agent.id);
      if (agent.id === activeAgentId) onActiveChange(await setActiveAgent("default"));
      setEditing((current) => (current.id === agent.id ? emptyAgent() : current));
      await refresh();
      onToast("ok", "Agent 已删除");
    });
  };

  return (
    <PanelShell variant="tabs" title="Agent 管理" onClose={onClose}>
      <div className="panel-sub">切换后，所选 Agent 的提示词会应用到后续消息。</div>
      <div className="agent-list">
        {agents.map((agent) => (
          <div key={agent.id} className={`agent-item ${agent.id === activeAgentId ? "active" : ""}`}>
            <div className="agent-row">
              <div>
                <div className="agent-name">{agent.name}{agent.id === activeAgentId && <span className="tag cur">当前</span>}</div>
                {agent.description && <div className="agent-description">{agent.description}</div>}
              </div>
              <div className="agent-actions">
                <button className="mini-btn" disabled={busy || agent.id === activeAgentId} onClick={() => void activate(agent.id)}>使用</button>
                <button className="mini-btn" disabled={busy} onClick={() => edit(agent)}>{agent.builtIn ? "记忆" : "编辑"}</button>
                {!agent.builtIn && <button className="mini-btn danger" disabled={busy} onClick={() => void remove(agent)}>删除</button>}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel-title" style={{ marginTop: "16px" }}>{editing.id ? "编辑 Agent" : "添加 Agent"}</div>
      <div className="form-row"><input className="grow" disabled={editing.id === "default"} placeholder="名称，例如：代码审查员" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
      <div className="form-row" style={{ marginTop: "6px" }}><input className="grow" disabled={editing.id === "default"} placeholder="简短说明（可选）" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
      <div className="form-row" style={{ marginTop: "6px" }}><textarea className="agent-prompt" disabled={editing.id === "default"} placeholder="编写这个 Agent 的提示词…" value={editing.prompt} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} /></div>
      <div className="agent-memory-head"><span>长期记忆</span><label className="mini-btn">导入文本<input type="file" accept=".md,.txt,text/markdown,text/plain" hidden onChange={async (e) => {
        const file = e.target.files?.[0]; if (!file) return;
        try { setEditing({ ...editing, memory: await file.text() }); onToast("ok", "长期记忆已导入，请保存 Agent"); }
        catch { onToast("error", "无法读取记忆文件"); } finally { e.target.value = ""; }
      }} /></label></div>
      <div className="agent-description">这里保存的是该 Agent 专属的稳定背景；Hermes Memory 还会为 Pi 提供跨会话检索、自动归纳与项目级记忆。</div>
      <div className="form-row" style={{ marginTop: "6px" }}><textarea className="agent-memory" placeholder="记录长期偏好、业务背景、项目约定或工作方法。每次使用该 Agent 时都会作为受控上下文提供。" value={editing.memory ?? ""} onChange={(e) => setEditing({ ...editing, memory: e.target.value })} /></div>
      <div className="form-row" style={{ marginTop: "8px" }}>
        <button className="btn primary" disabled={busy || !editing.name.trim()} onClick={() => void save()}>保存</button>
        {editing.id && <button className="btn" disabled={busy} onClick={() => setEditing(emptyAgent())}>取消编辑</button>}
      </div>
    </PanelShell>
  );
}
