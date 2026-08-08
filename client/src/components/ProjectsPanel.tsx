import { useEffect, useState } from "react";
import {
  addProjectDocument,
  assignSessionToProject,
  createProject,
  getProject,
  listProjects,
  removeProject,
  removeProjectDocument,
  removeProjectMemory,
  saveProjectMemory,
  searchProject,
  updateProject,
  uploadFiles,
} from "../api";
import type { Project, ProjectMemoryType, ProjectSearchResult, ProjectSummary } from "../types";

interface Props {
  projects: ProjectSummary[];
  currentSessionFile?: string;
  currentProjectId: string | null;
  onProjectsChange: (projects: ProjectSummary[]) => void;
  onStateRefresh: () => void;
  onSessionSelect: (file: string) => void;
  onClose: () => void;
  onToast: (level: "info" | "warn" | "error" | "ok", message: string) => void;
}

const emptyDraft = { name: "", description: "", workspacePath: "", instructions: "" };
const memoryTypes: ProjectMemoryType[] = ["fact", "decision", "preference", "summary"];

export function ProjectsPanel({ projects, currentSessionFile, currentProjectId, onProjectsChange, onStateRefresh, onSessionSelect, onClose, onToast }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [memory, setMemory] = useState<{ content: string; type: ProjectMemoryType; pinned: boolean }>({ content: "", type: "fact", pinned: false });
  const [documentPath, setDocumentPath] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<ProjectSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshProjects = async (nextSelectedId = selectedId) => {
    const summaries = await listProjects();
    onProjectsChange(summaries);
    const id = nextSelectedId && summaries.some((item) => item.id === nextSelectedId) ? nextSelectedId : summaries[0]?.id ?? null;
    setSelectedId(id);
    if (id) {
      const detail = await getProject(id);
      setProject(detail);
      setDraft({ name: detail.name, description: detail.description, workspacePath: detail.workspacePath ?? "", instructions: detail.instructions });
    } else {
      setProject(null);
      setDraft(emptyDraft);
    }
    setSearchResults([]);
  };

  useEffect(() => {
    void refreshProjects().catch((error) => onToast("error", (error as Error).message));
  }, []);

  useEffect(() => {
    const query = searchText.trim();
    if (!project || !query) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void searchProject(project.id, query)
        .then((results) => { if (!cancelled) setSearchResults(results); })
        .catch((error) => { if (!cancelled) onToast("error", (error as Error).message); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 240);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [project?.id, searchText, onToast]);

  const selectProject = async (id: string) => {
    setSelectedId(id);
    setSearchText("");
    try {
      const detail = await getProject(id);
      setProject(detail);
      setDraft({ name: detail.name, description: detail.description, workspacePath: detail.workspacePath ?? "", instructions: detail.instructions });
    } catch (error) {
      onToast("error", (error as Error).message);
    }
  };

  const save = async () => {
    if (!draft.name.trim()) {
      onToast("warn", "请输入项目名称");
      return;
    }
    setBusy(true);
    try {
      if (project) {
        await updateProject(project.id, { ...draft, workspacePath: draft.workspacePath.trim() || null });
        onToast("ok", "项目已更新");
        await refreshProjects(project.id);
      } else {
        const created = await createProject({ ...draft, workspacePath: draft.workspacePath.trim() || undefined });
        onToast("ok", "项目已创建");
        await refreshProjects(created.id);
      }
      onStateRefresh();
    } catch (error) {
      onToast("error", (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!project || !window.confirm("确定删除项目“" + project.name + "”吗？会话文件和文档不会被删除。")) return;
    setBusy(true);
    try {
      await removeProject(project.id);
      await refreshProjects(null);
      onStateRefresh();
      onToast("ok", "项目已删除");
    } catch (error) {
      onToast("error", (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addMemory = async () => {
    if (!project || !memory.content.trim()) return;
    setBusy(true);
    try {
      await saveProjectMemory(project.id, memory);
      setMemory({ content: "", type: "fact", pinned: false });
      await refreshProjects(project.id);
      onToast("ok", "项目记忆已保存");
    } catch (error) {
      onToast("error", (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addDocument = async (path: string, name?: string) => {
    if (!project || !path.trim()) return;
    setBusy(true);
    try {
      await addProjectDocument(project.id, { path: path.trim(), name });
      setDocumentPath("");
      await refreshProjects(project.id);
      onToast("ok", "项目文档已添加并建立索引");
    } catch (error) {
      onToast("error", (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uploadDocument = async (file: File) => {
    setBusy(true);
    try {
      const uploaded = await uploadFiles([file]);
      const item = uploaded[0];
      if (!item) throw new Error("上传没有返回文件");
      await addDocument(item.path, item.name);
    } catch (error) {
      onToast("error", (error as Error).message);
      setBusy(false);
    }
  };

  const addCurrentSession = async () => {
    if (!project || !currentSessionFile) return;
    setBusy(true);
    try {
      await assignSessionToProject(project.id, currentSessionFile);
      await refreshProjects(project.id);
      onStateRefresh();
      onToast("ok", "当前会话已加入项目");
    } catch (error) {
      onToast("error", (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openSearchResult = (result: ProjectSearchResult) => {
    if (result.kind === "session" && result.file) {
      onSessionSelect(result.file);
      onClose();
    }
  };

  return (
    <div className="panel-body" style={{ overflowY: "auto", flex: 1 }}>
      <div className="panel-tabs" style={{ margin: "-12px -12px 10px", padding: "0 12px", borderBottom: "1px solid var(--border)" }}>
        <span className="panel-title" style={{ lineHeight: "36px" }}>项目</span>
        <button className="icon-btn" title="关闭" style={{ marginLeft: "auto", marginTop: "8px" }} onClick={onClose}>×</button>
      </div>
      <div className="panel-sub">项目会话共享项目指令、记忆和文档引用；原始会话文件保持不变。</div>

      <div className="form-row" style={{ marginTop: 12 }}>
        <select className="grow" value={selectedId ?? ""} onChange={(event) => {
          if (event.target.value) void selectProject(event.target.value);
          else {
            setSelectedId(null);
            setProject(null);
            setDraft(emptyDraft);
            setSearchText("");
          }
        }}>
          <option value="">新建项目</option>
          {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>

      <div className="panel-title" style={{ marginTop: 16 }}>{project ? "项目设置" : "创建项目"}</div>
      <div className="form-row"><input className="grow" placeholder="项目名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
      <div className="form-row" style={{ marginTop: 6 }}><input className="grow" placeholder="项目说明（可选）" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></div>
      <div className="form-row" style={{ marginTop: 6 }}><input className="grow" placeholder="项目工作区路径（可选）" value={draft.workspacePath} onChange={(event) => setDraft({ ...draft, workspacePath: event.target.value })} /></div>
      <div className="form-row" style={{ marginTop: 6 }}><textarea className="grow" rows={4} placeholder="项目指令：所有项目会话都应遵守的约束" value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></div>
      <div className="settings-actions">
        <button className="mini-btn primary" disabled={busy} onClick={() => void save()}>{project ? "保存项目" : "创建项目"}</button>
        {project && <button className="mini-btn danger" disabled={busy} onClick={() => void remove()}>删除项目</button>}
      </div>

      {project && (
        <>
          <div className="panel-title" style={{ marginTop: 20 }}>项目内搜索</div>
          <div className="form-row project-search">
            <input className="grow" value={searchText} placeholder="搜索项目会话和文档全文" onChange={(event) => setSearchText(event.target.value)} />
            {searching && <span className="search-status">搜索中…</span>}
          </div>
          {searchText.trim() && !searching && searchResults.length === 0 && <div className="empty-inline">没有找到匹配内容</div>}
          {searchResults.length > 0 && (
            <div className="project-search-results">
              {searchResults.map((result) => (
                <button key={result.kind + ":" + result.id} className="project-search-result" disabled={result.kind !== "session"} onClick={() => openSearchResult(result)}>
                  <strong>{result.kind === "session" ? "会话 · " : "文档 · "}{result.title}</strong>
                  <span>{result.snippet}</span>
                  <small>{result.matches} 处匹配{result.kind === "session" ? " · 点击打开会话" : ""}</small>
                </button>
              ))}
            </div>
          )}

          <div className="panel-title" style={{ marginTop: 20 }}>会话归档</div>
          <div className="panel-sub">把当前或侧栏中选中的零散会话归入项目后，它们会自动获得项目上下文。</div>
          <button className="mini-btn" disabled={busy || !currentSessionFile || currentProjectId === project.id} onClick={() => void addCurrentSession()}>
            {currentProjectId === project.id ? "当前会话已在项目中" : "将当前会话加入项目"}
          </button>

          <div className="panel-title" style={{ marginTop: 20 }}>项目记忆</div>
          <div className="form-row"><textarea className="grow" rows={3} placeholder="记录可复用的事实、决策、偏好或阶段总结" value={memory.content} onChange={(event) => setMemory({ ...memory, content: event.target.value })} /></div>
          <div className="form-row" style={{ marginTop: 6 }}>
            <select value={memory.type} onChange={(event) => setMemory({ ...memory, type: event.target.value as ProjectMemoryType })}>{memoryTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select>
            <label className="checkbox-label"><input type="checkbox" checked={memory.pinned} onChange={(event) => setMemory({ ...memory, pinned: event.target.checked })} />置顶</label>
            <button className="mini-btn primary" disabled={busy || !memory.content.trim()} onClick={() => void addMemory()}>保存记忆</button>
          </div>
          <div className="agent-list">
            {project.memories.map((item) => (
              <div className="agent-item" key={item.id}>
                <div className="agent-row"><div><div className="agent-name">{item.pinned ? "置顶 · " : ""}{item.type}</div><div className="agent-description">{item.content}</div></div><div className="agent-actions"><button className="mini-btn danger" disabled={busy} onClick={() => void removeProjectMemory(project.id, item.id).then(() => refreshProjects(project.id)).catch((error) => onToast("error", (error as Error).message))}>删除</button></div></div>
              </div>
            ))}
          </div>

          <div className="panel-title" style={{ marginTop: 20 }}>项目文档</div>
          <div className="panel-sub">上传项目规范、需求、接口说明或设计文档，系统会在后台建立全文索引。</div>
          <div className="form-row">
            <input type="file" accept=".txt,.md,.markdown,.json,.csv,.ts,.tsx,.js,.jsx,.css,.html,.htm,.xml,.yaml,.yml,.log,.docx,.pptx,.xlsx,.xls" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ""; if (file) void uploadDocument(file); }} />
          </div>
          <div className="form-row" style={{ marginTop: 6 }}>
            <input className="grow" placeholder="也可以添加本机文档路径" value={documentPath} onChange={(event) => setDocumentPath(event.target.value)} />
            <button className="mini-btn primary" disabled={busy || !documentPath.trim()} onClick={() => void addDocument(documentPath)}>添加</button>
          </div>
          <div className="agent-list">
            {project.documents.map((item) => (
              <div className="agent-item" key={item.id}>
                <div className="agent-row"><div><div className="agent-name">{item.name} <span className="index-status">{item.indexedAt ? "已建立索引" : "未建立索引"}</span></div><div className="agent-description" title={item.path}>{item.path}</div></div><div className="agent-actions"><button className="mini-btn danger" disabled={busy} onClick={() => void removeProjectDocument(project.id, item.id).then(() => refreshProjects(project.id)).catch((error) => onToast("error", (error as Error).message))}>移除</button></div></div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
