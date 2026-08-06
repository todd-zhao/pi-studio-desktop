import { useCallback, useEffect, useState } from "react";
import { listWorkspaceFiles } from "../api";
import type { FileEntry } from "../types";

interface DirState {
  loaded: boolean;
  loading: boolean;
  entries: FileEntry[];
  error: string;
}

interface Props {
  onPickFile: (relPath: string, name: string) => void;
  onPreview?: (relPath: string, name: string) => void;
  onPickDir?: (relPath: string) => void;
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "🖼";
  if (["pdf"].includes(ext)) return "📄";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "🗜";
  if (["py", "ts", "tsx", "js", "jsx", "go", "rs", "java", "c", "cpp", "rb"].includes(ext)) return "⌨";
  if (["xlsx", "xls", "csv"].includes(ext)) return "📊";
  if (["doc", "docx"].includes(ext)) return "📝";
  if (["md"].includes(ext)) return "📘";
  if (["json", "yaml", "yml", "toml"].includes(ext)) return "⚙";
  if (["html", "css", "scss"].includes(ext)) return "🌐";
  return "📄";
}

function DirRow({ entry, depth, onPickFile, onPreview, onPickDir }: {
  entry: FileEntry;
  depth: number;
  onPickFile: Props["onPickFile"];
  onPreview?: Props["onPreview"];
  onPickDir?: Props["onPickDir"];
}) {
  const [state, setState] = useState<DirState>({ loaded: false, loading: false, entries: [], error: "" });
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const entries = await listWorkspaceFiles(entry.path);
      setState({ loaded: true, loading: false, entries, error: "" });
    } catch (e) {
      setState({ loaded: true, loading: false, entries: [], error: (e as Error).message });
    }
  }, [entry.path]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!state.loaded && !state.loading) void load();
  };

  return (
    <div>
      <div
        className={`ft-row ${open ? "ft-open" : ""}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={toggle}
        title={entry.path}
      >
        <span className="ft-arrow">{open ? "▾" : "▸"}</span>
        <span className="ft-icon">📁</span>
        <span className="ft-name">{entry.name}</span>
      </div>
      {open && (
        <div>
          {state.loading && <div className="ft-hint" style={{ paddingLeft: `${24 + depth * 14}px` }}>加载中…</div>}
          {state.error && <div className="ft-hint err" style={{ paddingLeft: `${24 + depth * 14}px` }}>⚠ {state.error}</div>}
          {state.loaded && state.entries.length === 0 && (
            <div className="ft-hint" style={{ paddingLeft: `${24 + depth * 14}px` }}>（空目录）</div>
          )}
          {state.entries.map((e) =>
            e.isDir ? (
              <DirRow key={e.path} entry={e} depth={depth + 1} onPickFile={onPickFile} onPreview={onPreview} onPickDir={onPickDir} />
            ) : (
              <div
                key={e.path}
                className="ft-row ft-file"
                style={{ paddingLeft: `${24 + depth * 14}px` }}
                title={`点击预览 ${e.path}（＋ 插入引用）`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onPreview?.(e.path, e.name);
                }}
              >
                <span className="ft-arrow" style={{ visibility: "hidden" }}>▸</span>
                <span className="ft-icon">{fileIcon(e.name)}</span>
                <span className="ft-name">{e.name}</span>
                <button
                  className="ft-add"
                  title={`插入引用 @${e.path}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onPickFile(e.path, e.name);
                  }}
                >
                  ＋
                </button>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function FileTree({ onPickFile, onPreview, onPickDir }: Props) {
  const [root, setRoot] = useState<DirState>({ loaded: false, loading: false, entries: [], error: "" });

  useEffect(() => {
    setRoot({ loaded: false, loading: true, entries: [], error: "" });
    listWorkspaceFiles("")
      .then((entries) => setRoot({ loaded: true, loading: false, entries, error: "" }))
      .catch((e) => setRoot({ loaded: true, loading: false, entries: [], error: (e as Error).message }));
  }, []);

  return (
    <div className="file-tree">
      <div className="ft-root">工作区根目录</div>
      {root.loading && <div className="ft-hint">加载中…</div>}
      {root.error && <div className="ft-hint err">⚠ {root.error}</div>}
      {root.loaded && root.entries.length === 0 && <div className="ft-hint">（空目录）</div>}
      {root.entries.map((e) =>
        e.isDir ? (
          <DirRow key={e.path} entry={e} depth={0} onPickFile={onPickFile} onPreview={onPreview} onPickDir={onPickDir} />
        ) : (
          <div
            key={e.path}
            className="ft-row ft-file"
            style={{ paddingLeft: "22px" }}
            title={`点击预览 ${e.path}（＋ 插入引用）`}
            onClick={() => onPreview?.(e.path, e.name)}
          >
            <span className="ft-arrow" style={{ visibility: "hidden" }}>▸</span>
            <span className="ft-icon">{fileIcon(e.name)}</span>
            <span className="ft-name">{e.name}</span>
            <button
              className="ft-add"
              title={`插入引用 @${e.path}`}
              onClick={(ev) => {
                ev.stopPropagation();
                onPickFile(e.path, e.name);
              }}
            >
              ＋
            </button>
          </div>
        ),
      )}
    </div>
  );
}
