import { useEffect, useState } from "react";
import { listSchedules, removeSchedule, runSchedule, saveSchedule, setScheduleEnabled } from "../api";
import type { AgentProfile, ScheduledTask } from "../types";
import { PanelShell } from "./PanelShell";

const blank = (): Partial<ScheduledTask> => ({ name: "", prompt: "", agentId: "default", kind: "daily", time: "09:00", enabled: true, intervalMinutes: 60, weekday: 1 });

export function SchedulesPanel({ agents, onClose, onToast }: { agents: AgentProfile[]; onClose: () => void; onToast: (l: "info" | "warn" | "error" | "ok", m: string) => void }) {
  const [items, setItems] = useState<ScheduledTask[]>([]);
  const [draft, setDraft] = useState<Partial<ScheduledTask>>(blank());

  const refresh = () => void listSchedules().then(setItems).catch((e) => onToast("error", e.message));
  useEffect(refresh, []);

  const save = async () => {
    try {
      if (!draft.name?.trim() || !draft.prompt?.trim()) throw new Error("请填写名称和任务内容");
      await saveSchedule(draft);
      setDraft(blank());
      refresh();
      onToast("ok", "定时任务已保存");
    } catch (e) {
      onToast("error", (e as Error).message);
    }
  };

  return (
    <PanelShell variant="head" className="schedules-panel" title="定时任务" hint="任务本地保存；Agent 忙碌时会作为后续消息排队执行。" onClose={onClose}>
      <div className="schedule-form">
        <input placeholder="任务名称" value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <textarea placeholder="到时发送给 Agent 的任务内容" value={draft.prompt ?? ""} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
        <select value={draft.agentId ?? "default"} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <select value={draft.kind ?? "daily"} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ScheduledTask["kind"] })}>
          <option value="once">一次</option>
          <option value="interval">间隔</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
        </select>
        {draft.kind === "once" && <input type="datetime-local" value={draft.at ?? ""} onChange={(e) => setDraft({ ...draft, at: e.target.value })} />}
        {draft.kind === "interval" && <input type="number" min="1" value={draft.intervalMinutes ?? 60} onChange={(e) => setDraft({ ...draft, intervalMinutes: +e.target.value })} />}
        {(draft.kind === "daily" || draft.kind === "weekly") && <input type="time" value={draft.time ?? "09:00"} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />}
        {draft.kind === "weekly" && (
          <select value={draft.weekday ?? 1} onChange={(e) => setDraft({ ...draft, weekday: +e.target.value })}>
            {["日", "一", "二", "三", "四", "五", "六"].map((d, i) => (
              <option key={i} value={i}>周{d}</option>
            ))}
          </select>
        )}
        <button className="btn primary" onClick={() => void save()}>保存任务</button>
      </div>
      <div className="schedule-list">
        {items.map((t) => (
          <div className="schedule-card" key={t.id}>
            <strong>{t.name}</strong>
            <small>{t.kind} · 下次：{t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : "已暂停"}</small>
            <p>{t.prompt}</p>
            <small>最近：{t.lastStatus ?? "未执行"} {t.lastResult ?? ""}</small>
            <div>
              <button className="mini-btn" onClick={() => void runSchedule(t.id).then(refresh)}>立即执行</button>
              <button className="mini-btn" onClick={() => void setScheduleEnabled(t.id, !t.enabled).then(refresh)}>{t.enabled ? "暂停" : "启用"}</button>
              <button className="mini-btn" onClick={() => void removeSchedule(t.id).then(refresh)}>删除</button>
            </div>
          </div>
        ))}
      </div>
    </PanelShell>
  );
}
