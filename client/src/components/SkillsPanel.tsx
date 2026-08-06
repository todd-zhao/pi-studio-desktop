import { useEffect, useRef, useState } from "react";
import { importSkills, listSkills, removeSkill } from "../api";
import type { SkillSummary } from "../types";

interface Props {
  onClose: () => void;
  onToast: (level: "info" | "warn" | "error" | "ok", message: string) => void;
}

export function SkillsPanel({ onClose, onToast }: Props) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [directory, setDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const folderInput = useRef<HTMLInputElement | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await listSkills();
      setSkills(result.skills);
      setDirectory(result.directory);
    } catch (e) {
      onToast("error", (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const importFiles = async (fileList: FileList | null) => {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    setBusy(true);
    try {
      const result = await importSkills(files);
      setSkills(result.skills);
      onToast("ok", `已导入 ${result.imported.length} 个 skill，并立即加载`);
    } catch (e) {
      onToast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (skill: SkillSummary) => {
    if (!window.confirm(`确定删除 skill “${skill.name}”吗？`)) return;
    setBusy(true);
    try {
      setSkills(await removeSkill(skill.name));
      onToast("ok", `已删除 ${skill.name}`);
    } catch (e) {
      onToast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel-tabs">
        <div className="panel-tab active">Skills</div>
        <div className="panel-tab" onClick={onClose}>关闭 ×</div>
      </div>
      <div className="panel-body">
        <div className="panel-title">已加载的 skills</div>
        <div className="panel-sub">只读取应用目录，不读取本机全局 Pi skills。</div>
        <div className="skill-dir">保存位置：{directory || "加载中…"}</div>
        {loading && <div className="ft-hint">加载中…</div>}
        {!loading && skills.length === 0 && <div className="ft-hint">暂无 skill，首次打开保持干净。</div>}
        {skills.map((skill) => (
          <div className="mcp-server" key={skill.name}>
            <div className="row1">
              <span className="sname">{skill.name}</span>
              <span className="sact">
                <button className="mini-btn danger" disabled={busy} onClick={() => void remove(skill)}>删除</button>
              </span>
            </div>
            <div className="row2">{skill.description}</div>
          </div>
        ))}

        <div className="panel-title" style={{ marginTop: "8px" }}>添加 skill</div>
        <div className="panel-sub">上传 skill 的 ZIP 文件，或选择包含一个/多个 skill 文件夹的目录。每个 skill 文件夹必须包含 SKILL.md。</div>
        <div className="skill-import-actions">
          <label className="btn primary">
            上传 ZIP
            <input
              hidden
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => { void importFiles(e.target.files); e.currentTarget.value = ""; }}
            />
          </label>
          <button className="btn" disabled={busy} onClick={() => folderInput.current?.click()}>
            上传文件夹
          </button>
          <input
            hidden
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => { void importFiles(e.target.files); e.currentTarget.value = ""; }}
            ref={(node) => {
              folderInput.current = node;
              if (node) {
                node.setAttribute("webkitdirectory", "");
                node.setAttribute("directory", "");
              }
            }}
          />
        </div>
      </div>
    </>
  );
}
