import { useCallback, useEffect, useRef, useState } from "react";
import {
  TeamSocket, acceptTeamInvitation, addTaskComment, claimTeamTask, clearTeamContent, createInvitation, createTeamTask,
  deleteTaskArtifact, deleteTeamTask, downloadTaskArtifact, getTeamServerUrl, getTeamTask, getTeamToken, listTeamMembers, listTeamTasks,
  removeTeamMember, saveTeamConnection, teamBootstrap, teamHealth, teamLogin, teamMe, updateTeamMemberRole, updateTeamTask, uploadTaskArtifact,
  type TaskDetail, type TeamMember, type TeamRole, type TeamTask, type TeamUser,
} from "../team-api";

import { confirmDialog } from "./confirm";
import { PanelShell } from "./PanelShell";
import { usePanel } from "../hooks/usePanel";

interface Props {
  onClose: () => void;
  onToast: (level: "info" | "warn" | "error" | "ok", message: string) => void;
}

const statusName: Record<string, string> = {
  open: "待领取", assigned: "待开始", in_progress: "进行中", review: "待审核", changes_requested: "需修改", done: "已完成",
};

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Some desktop/browser policies reject the Clipboard API. Fall back to a
    // temporary selection so the generated invitation is still usable.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function TeamPanel({ onClose, onToast }: Props) {
  const [serverUrl, setServerUrl] = useState(getTeamServerUrl());
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [user, setUser] = useState<TeamUser | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [mode, setMode] = useState<"login" | "join" | "bootstrap">("login");
  const [credentials, setCredentials] = useState({ username: "", displayName: "", password: "", teamName: "", code: "" });
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: "", description: "", assigneeId: "", resultType: "file", priority: "normal" });
  const [comment, setComment] = useState("");
  const [fileNote, setFileNote] = useState("");
  const [lastInvite, setLastInvite] = useState<{ code: string; expiresAt: number } | null>(null);
  const [inviteRole, setInviteRole] = useState<Exclude<TeamRole, "owner">>("member");
  const [showMembers, setShowMembers] = useState(false);
  const { busy, setBusy, run } = usePanel(onToast);
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshTasks = useCallback(async () => {
    const next = await listTeamTasks(); setTasks(next);
    if (detail) setDetail(await getTeamTask(detail.task.id));
  }, [detail?.task.id]);

  const connect = useCallback(async () => {
    saveTeamConnection(serverUrl);
    try {
      const health = await teamHealth(); setInitialized(health.initialized);
      if (!health.initialized) setMode("bootstrap");
      if (getTeamToken()) {
        const current = await teamMe(); setUser(current);
        const [nextMembers, nextTasks] = await Promise.all([listTeamMembers(), listTeamTasks()]);
        setMembers(nextMembers); setTasks(nextTasks);
      }
    } catch (error) {
      setUser(null); onToast("error", (error as Error).message);
    }
  }, [serverUrl, onToast]);

  useEffect(() => { void connect(); }, []);
  useEffect(() => {
    if (!user) return;
    const socket = new TeamSocket(); return socket.connect(() => void refreshTasks().catch(() => {}));
  }, [user?.id, refreshTasks]);

  const authenticate = async () => {
    saveTeamConnection(serverUrl, "");
    await run(async () => {
      const input = credentials;
      const result = mode === "bootstrap"
        ? await teamBootstrap({ teamName: input.teamName, username: input.username, displayName: input.displayName, password: input.password })
        : mode === "join"
          ? await acceptTeamInvitation({ code: input.code, username: input.username, displayName: input.displayName, password: input.password })
          : await teamLogin(input.username, input.password);
      saveTeamConnection(serverUrl, result.token); setUser(result.user); setInitialized(true);
      const [nextMembers, nextTasks] = await Promise.all([listTeamMembers(), listTeamTasks()]);
      setMembers(nextMembers); setTasks(nextTasks); onToast("ok", `已进入 ${result.user.teamName}`);
    });
  };

  const openTask = async (task: TeamTask) => {
    try { setDetail(await getTeamTask(task.id)); } catch (error) { onToast("error", (error as Error).message); }
  };

  const submitTask = async () => {
    await run(async () => {
      await createTeamTask({ ...draft, assigneeId: draft.assigneeId || undefined });
      setDraft({ title: "", description: "", assigneeId: "", resultType: "file", priority: "normal" }); setCreating(false);
      await refreshTasks(); onToast("ok", "团队任务已创建");
    });
  };

  const changeStatus = async (status: string) => {
    if (!detail) return;
    await run(async () => {
      await updateTeamTask(detail.task.id, { status, revision: detail.task.revision }); await refreshTasks();
    });
  };

  const refreshMembers = async () => setMembers(await listTeamMembers());

  if (!user) {
    return (
      <div className="team-panel panel-body">
        <PanelShell variant="team" title="团队空间" onClose={onClose} />
        <div className="panel-sub">连接团队服务器后，成员可以共享任务、评论和成果文件。</div>
        <label className="team-label">服务器地址</label>
        <div className="form-row"><input className="grow" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} /><button className="btn" onClick={() => void connect()}>检测</button></div>
        <div className="team-auth-tabs">
          {initialized !== false && <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button>}
          <button className={mode === "join" ? "active" : ""} onClick={() => setMode("join")}>邀请码加入</button>
          {initialized === false && <button className={mode === "bootstrap" ? "active" : ""} onClick={() => setMode("bootstrap")}>创建团队</button>}
        </div>
        {mode === "bootstrap" && <TeamInput label="团队名称" value={credentials.teamName} onChange={(teamName) => setCredentials({ ...credentials, teamName })} />}
        {mode === "join" && <TeamInput label="邀请码" value={credentials.code} onChange={(code) => setCredentials({ ...credentials, code })} />}
        <TeamInput label="用户名" value={credentials.username} onChange={(username) => setCredentials({ ...credentials, username })} />
        {mode !== "login" && <TeamInput label="显示名称" value={credentials.displayName} onChange={(displayName) => setCredentials({ ...credentials, displayName })} />}
        <TeamInput label="密码" type="password" value={credentials.password} onChange={(password) => setCredentials({ ...credentials, password })} />
        <button className="btn primary team-primary" disabled={busy} onClick={() => void authenticate()}>{mode === "login" ? "登录团队" : mode === "join" ? "加入团队" : "创建团队"}</button>
      </div>
    );
  }

  if (detail) {
    const canEdit = user.role !== "guest";
    return (
      <div className="team-panel panel-body">
        <PanelShell variant="team" title="任务详情" onClose={() => setDetail(null)} closeLabel="返回" />
        <div className="team-task-head"><span className={`team-status ${detail.task.status}`}>{statusName[detail.task.status] ?? detail.task.status}</span><span className="team-muted">{detail.task.assignee_name || "未分配"}</span></div>
        <h3 className="team-task-title">{detail.task.title}</h3>
        {detail.task.description && <div className="team-description">{detail.task.description}</div>}
        {canEdit && <div className="team-actions">
          {!detail.task.assignee_id && <button className="btn primary" disabled={busy} onClick={() => void claimTeamTask(detail.task.id).then(refreshTasks).catch((e) => onToast("error", e.message))}>领取任务</button>}
          {detail.task.assignee_id === user.id && detail.task.status !== "review" && detail.task.status !== "done" && <button className="btn" onClick={() => void changeStatus("review")}>提交审核</button>}
          {(user.role === "owner" || user.role === "admin") && detail.task.status === "review" && <><button className="btn primary" onClick={() => void changeStatus("done")}>审核通过</button><button className="btn" onClick={() => void changeStatus("changes_requested")}>需要修改</button></>}
          {(user.role === "owner" || user.role === "admin") && <button className="btn danger" onClick={async () => {
            if (!(await confirmDialog(`确定删除任务“${detail.task.title}”及全部成果文件吗？此操作无法恢复。`, { danger: true, confirmText: "删除" }))) return;
            try { await deleteTeamTask(detail.task.id); setDetail(null); await refreshTasks(); onToast("ok", "任务已删除"); }
            catch (error) { onToast("error", (error as Error).message); }
          }}>删除任务</button>}
        </div>}

        <section className="team-block"><h4>成果文件 <span>{detail.artifacts.length}</span></h4>
          {detail.artifacts.map((artifact) => <div key={artifact.id} className="team-artifact-row">
            <button className="team-artifact" onClick={() => void downloadTaskArtifact(artifact).catch((e) => onToast("error", e.message))}><span>{artifact.original_name}</span><small>v{artifact.version} · {artifact.uploader_name}</small></button>
            {(user.role === "owner" || user.role === "admin" || artifact.uploaded_by === user.id) && <button className="mini-btn danger" onClick={async () => {
              if (!(await confirmDialog(`确定删除文件“${artifact.original_name}”吗？`, { danger: true, confirmText: "删除" }))) return;
              try { await deleteTaskArtifact(artifact.id); await refreshTasks(); onToast("ok", "文件已删除"); }
              catch (error) { onToast("error", (error as Error).message); }
            }}>删除</button>}
          </div>)}
          {canEdit && <><input ref={fileRef} type="file" hidden onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return; setBusy(true);
            try { await uploadTaskArtifact(detail.task.id, file, fileNote); setFileNote(""); await refreshTasks(); onToast("ok", "成果文件已上传"); }
            catch (error) { onToast("error", (error as Error).message); } finally { setBusy(false); e.target.value = ""; }
          }} /><div className="form-row"><input className="grow" placeholder="版本说明（可选）" value={fileNote} onChange={(e) => setFileNote(e.target.value)} /><button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>上传</button></div></>}
        </section>

        <section className="team-block"><h4>讨论 <span>{detail.comments.length}</span></h4>
          {detail.comments.map((item) => <div key={item.id} className="team-comment"><b>{item.user_name}</b><span>{item.body}</span><small>{new Date(item.created_at).toLocaleString()}</small></div>)}
          {canEdit && <div className="form-row"><input className="grow" placeholder="添加评论" value={comment} onChange={(e) => setComment(e.target.value)} /><button className="btn" disabled={!comment.trim()} onClick={async () => { await addTaskComment(detail.task.id, comment); setComment(""); await refreshTasks(); }}>发送</button></div>}
        </section>
      </div>
    );
  }

  return (
    <div className="team-panel panel-body">
      <PanelShell variant="team" title={user.teamName} onClose={onClose} />
      <div className="team-user-row"><span>{user.displayName}</span><span className="team-role">{user.role}</span><button className="mini-btn" onClick={() => { saveTeamConnection(serverUrl, ""); setUser(null); }}>退出</button></div>
      <div className="team-toolbar">
        {user.role !== "guest" && <button className="btn primary" onClick={() => setCreating(!creating)}>＋ 新任务</button>}
        {user.role === "owner" && <button className="btn" onClick={() => setShowMembers(!showMembers)}>{showMembers ? "返回任务" : "成员管理"}</button>}
        {(user.role === "owner" || user.role === "admin") && <><select className="team-role-select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Exclude<TeamRole, "owner">)}><option value="member">成员</option><option value="guest">访客（只读）</option>{user.role === "owner" && <option value="admin">管理员</option>}</select><button className="btn" onClick={async () => {
          try {
            const invite = await createInvitation(inviteRole);
            setLastInvite(invite);
            const copied = await copyText(invite.code);
            onToast(copied ? "ok" : "info", copied ? `${inviteRole === "guest" ? "访客" : inviteRole === "admin" ? "管理员" : "成员"}邀请码 ${invite.code} 已复制` : `邀请码 ${invite.code} 已生成，请手动复制`);
          }
          catch (error) { onToast("error", (error as Error).message); }
        }}>邀请成员</button></>}
      </div>
      {lastInvite && <div className="team-invite-result">
        <div><span>邀请码</span><strong>{lastInvite.code}</strong><small>有效期至 {new Date(lastInvite.expiresAt).toLocaleString()}</small></div>
        <button className="btn" onClick={async () => {
          const copied = await copyText(lastInvite.code);
          onToast(copied ? "ok" : "info", copied ? "邀请码已复制" : "无法访问剪贴板，请手动选择邀请码复制");
        }}>复制</button>
      </div>}
      {showMembers ? <section className="team-members-card">
        <div className="panel-sub">Owner 可以调整成员角色或移除成员；被移除的成员立即退出团队，但其历史任务记录会保留。</div>
        {members.map((member) => <div className="team-member-item" key={member.id}>
          <div><strong>{member.displayName}</strong><small>{member.username}</small></div>
          {member.role === "owner" ? <span className="team-role">所有者</span> : <><select value={member.role} disabled={busy} onChange={async (e) => {
            setBusy(true);
            try { await updateTeamMemberRole(member.id, e.target.value as Exclude<TeamRole, "owner">); await refreshMembers(); onToast("ok", "成员角色已更新"); }
            catch (error) { onToast("error", (error as Error).message); } finally { setBusy(false); }
          }}><option value="admin">管理员</option><option value="member">成员</option><option value="guest">访客</option></select><button className="mini-btn danger" disabled={busy} onClick={async () => {
            if (!(await confirmDialog(`确定移除成员“${member.displayName}”吗？`, { danger: true, confirmText: "移除" }))) return;
            setBusy(true);
            try { await removeTeamMember(member.id); await refreshMembers(); onToast("ok", "成员已移除"); }
            catch (error) { onToast("error", (error as Error).message); } finally { setBusy(false); }
          }}>移除</button></>}
        </div>)}
        <button className="btn danger team-clear-content" disabled={busy} onClick={async () => {
          if (!(await confirmDialog("确定清空全部任务、评论和成果文件吗？\n成员账号与团队名称会保留，此操作无法恢复。", { title: "清空团队内容", danger: true, confirmText: "清空" }))) return;
          setBusy(true);
          try { const result = await clearTeamContent(); setDetail(null); await refreshTasks(); onToast("ok", `已清空 ${result.removedTasks} 个任务及其成果文件`); }
          catch (error) { onToast("error", (error as Error).message); } finally { setBusy(false); }
        }}>清空全部团队内容</button>
      </section> : <>
      {creating && <div className="team-create-card">
        <input placeholder="任务标题" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <textarea placeholder="任务说明和完成标准" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <div className="form-row"><select value={draft.assigneeId} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}><option value="">待领取</option>{members.filter((m) => m.role !== "guest").map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select>
          <select value={draft.resultType} onChange={(e) => setDraft({ ...draft, resultType: e.target.value })}><option value="file">文件成果</option><option value="document">在线文档</option><option value="code">代码修改</option><option value="other">其他</option></select></div>
        <button className="btn primary" disabled={busy || !draft.title.trim()} onClick={() => void submitTask()}>创建任务</button>
      </div>}
      <div className="team-task-list">
        {tasks.length === 0 && <div className="team-empty">暂无团队任务</div>}
        {tasks.map((task) => <button key={task.id} className="team-task-card" onClick={() => void openTask(task)}>
          <div><span className={`team-status ${task.status}`}>{statusName[task.status] ?? task.status}</span><span className="team-muted">{task.assignee_name || "待领取"}</span></div>
          <strong>{task.title}</strong>
          <small>{task.creator_name} · {task.comment_count ?? 0} 条评论 · {task.artifact_count ?? 0} 个文件</small>
        </button>)}
      </div>
      </>}
    </div>
  );
}

function TeamInput({ label, value, type = "text", onChange }: { label: string; value: string; type?: string; onChange: (value: string) => void }) {
  return <label className="team-field"><span>{label}</span><input type={type} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
