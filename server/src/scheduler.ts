import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ScheduleKind = "once" | "interval" | "daily" | "weekly";
export interface ScheduledTask {
  id: string; name: string; prompt: string; agentId: string; kind: ScheduleKind;
  at?: string; intervalMinutes?: number; time?: string; weekday?: number;
  enabled: boolean; nextRunAt?: number; lastRunAt?: number; lastStatus?: "success" | "error" | "queued"; lastResult?: string;
}

export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timer?: NodeJS.Timeout;
  constructor(private readonly file: string, private readonly run: (task: ScheduledTask) => Promise<void>) { this.load(); this.tick(); this.timer = setInterval(() => this.tick(), 15_000); }
  list() { return [...this.tasks].sort((a,b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)); }
  saveTask(input: Omit<ScheduledTask,"id"|"nextRunAt"|"lastRunAt"|"lastStatus"|"lastResult"> & { id?: string }) { const old = input.id ? this.tasks.find(t => t.id === input.id) : undefined; const task: ScheduledTask = { ...old, ...input, id: input.id ?? `schedule-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, nextRunAt: this.next(input, Date.now()) } as ScheduledTask; this.tasks = old ? this.tasks.map(t => t.id === task.id ? task : t) : [...this.tasks, task]; this.persist(); return task; }
  remove(id: string) { this.tasks = this.tasks.filter(t => t.id !== id); this.persist(); }
  async trigger(id: string) { const task = this.tasks.find(t => t.id === id); if (!task) throw new Error("定时任务不存在"); await this.execute(task); }
  setEnabled(id: string, enabled: boolean) { const task=this.tasks.find(t=>t.id===id); if(!task) throw new Error("定时任务不存在"); task.enabled=enabled; task.nextRunAt=enabled?this.next(task,Date.now()):undefined; this.persist(); return task; }
  private tick() { const now=Date.now(); for(const task of this.tasks) if(task.enabled && task.nextRunAt && task.nextRunAt<=now) void this.execute(task); }
  private async execute(task: ScheduledTask) { task.lastRunAt=Date.now(); task.lastStatus="queued"; task.nextRunAt=this.next(task, task.lastRunAt+1000); this.persist(); try { await this.run(task); task.lastStatus="success"; task.lastResult="已发送给 Agent"; } catch(e) { task.lastStatus="error"; task.lastResult=(e as Error).message; } this.persist(); }
  private next(t: Partial<ScheduledTask>, from: number) { if(!t.enabled) return undefined; if(t.kind==="once") { const v=t.at?Date.parse(t.at):NaN; return Number.isFinite(v)&&v>from?v:undefined; } if(t.kind==="interval") return from + Math.max(1,t.intervalMinutes??60)*60_000; const [h,m]=(t.time??"09:00").split(":").map(Number); const d=new Date(from); d.setSeconds(0,0); d.setHours(h||0,m||0,0,0); if(d.getTime()<=from) d.setDate(d.getDate()+1); if(t.kind==="weekly") { const target=t.weekday??1; d.setDate(d.getDate()+((target-d.getDay()+7)%7)); if(d.getTime()<=from) d.setDate(d.getDate()+7); } return d.getTime(); }
  private load() { try { if(existsSync(this.file)) this.tasks=JSON.parse(readFileSync(this.file,"utf8")); } catch { this.tasks=[]; } for(const t of this.tasks) if(t.enabled) t.nextRunAt ??= this.next(t,Date.now()); }
  private persist() { mkdirSync(dirname(this.file),{recursive:true}); writeFileSync(this.file,JSON.stringify(this.tasks,null,2)); }
}
