import { useCallback, useEffect, useState } from "react";
import { listWorkspaceFiles, moveWorkspaceFile } from "../api";
import type { FileEntry } from "../types";
import { DirPicker } from "./DirPicker";

interface DirState {
  loaded: boolean;
  loading: boolean;
  entries: FileEntry[];
  error: string;
}

interface Props {
  onPickFile: (relPath: string, name: string, root?: string) => void;
  onPreview?: (relPath: string, name: string, root?: string) => void;
  onPickDir?: (relPath: string, root?: string) => void;
  rootPath?: string;
  roots?: string[];
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
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

function DirRow({ entry, depth, root, onPickFile, onPreview, onPickDir, onMoveFile, treeVersion }: {
  entry: FileEntry;
  depth: number;
  root?: string;
  onPickFile: Props["onPickFile"];
  onPreview?: Props["onPreview"];
  onPickDir?: Props["onPickDir"];
  onMoveFile?: (path: string, root?: string) => void;
  treeVersion: number;
}) {
  const [state, setState] = useState<DirState>({ loaded: false, loading: false, entries: [], error: "" });
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const entries = await listWorkspaceFiles(entry.path, root);
      setState({ loaded: true, loading: false, entries, error: "" });
    } catch (e) {
      setState({ loaded: true, loading: false, entries: [], error: (e as Error).message });
    }
  }, [entry.path, root]);

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
        <button
          className="ft-add"
          title={`插入引用 @${entry.path}/`}
          onClick={(ev) => {
            ev.stopPropagation();
            onPickDir?.(entry.path, root);
          }}
        >
          ＋
        </button>
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
              <DirRow key={`${root ?? ""}|${e.path}-${treeVersion}`} entry={e} depth={depth + 1} root={root} onPickFile={onPickFile} onPreview={onPreview} onPickDir={onPickDir} onMoveFile={onMoveFile} treeVersion={treeVersion} />
            ) : (
              <div
                key={`${root ?? ""}|${e.path}`}
                className="ft-row ft-file"
                style={{ paddingLeft: `${24 + depth * 14}px` }}
                title={`点击预览 ${e.path}（＋ 插入引用）`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onPreview?.(e.path, e.name, root);
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
                    onPickFile(e.path, e.name, root);
                  }}
                >
                  ＋
                </button>
                <button
                  className="ft-move"
                  title="移动文件"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onMoveFile?.(e.path, root);
                  }}
                >
                  ↗
                </button>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function RootTree({ root, treeVersion, onPickFile, onPreview, onPickDir, onMoveFile }: {
  root?: string;
  treeVersion: number;
  onPickFile: Props["onPickFile"];
  onPreview?: Props["onPreview"];
  onPickDir?: Props["onPickDir"];
  onMoveFile?: (path: string, root?: string) => void;
}) {
  const [state, setState] = useState<DirState>({ loaded: false, loading: false, entries: [], error: "" });
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setState({ loaded: false, loading: true, entries: [], error: "" });
    listWorkspaceFiles("", root)
      .then((entries) => setState({ loaded: true, loading: false, entries, error: "" }))
      .catch((e) => setState({ loaded: true, loading: false, entries: [], error: (e as Error).message }));
  }, [treeVersion, root]);

  const title = root ? basename(root) || root : "工作区根目录";

  return (
    <div>
      <div
        className="ft-row ft-root-row"
        onClick={() => setOpen((o) => !o)}
        title={root ?? "工作区根目录"}
      >
        <span className="ft-arrow">{open ? "▾" : "▸"}</span>
        <span className="ft-icon">📁</span>
        <span className="ft-name">{title}</span>
      </div>
      {open && (
        <>
          {state.loading && <div className="ft-hint">加载中…</div>}
          {state.error && <div className="ft-hint err">⚠ {state.error}</div>}
          {state.loaded && state.entries.length === 0 && <div className="ft-hint">（空目录）</div>}
          {state.entries.map((e) =>
            e.isDir ? (
              <DirRow key={`${root ?? ""}|${e.path}-${treeVersion}`} entry={e} depth={0} root={root} onPickFile={onPickFile} onPreview={onPreview} onPickDir={onPickDir} onMoveFile={onMoveFile} treeVersion={treeVersion} />
            ) : (
              <div
                key={`${root ?? ""}|${e.path}`}
                className="ft-row ft-file"
                style={{ paddingLeft: "22px" }}
                title={`点击预览 ${e.path}（＋ 插入引用）`}
                onClick={() => onPreview?.(e.path, e.name, root)}
              >
                <span className="ft-arrow" style={{ visibility: "hidden" }}>▸</span>
                <span className="ft-icon">{fileIcon(e.name)}</span>
                <span className="ft-name">{e.name}</span>
                <button
                  className="ft-add"
                  title={`插入引用 @${e.path}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onPickFile(e.path, e.name, root);
                  }}
                >
                  ＋
                </button>
                <button
                  className="ft-move"
                  title="移动文件"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onMoveFile?.(e.path, root);
                  }}
                >
                  ↗
                </button>
              </div>
            ),
          )}
        </>
      )}
    </div>
  );
}

export function FileTree({ onPickFile, onPreview, onPickDir, rootPath, roots }: Props) {
  const [treeVersion, setTreeVersion] = useState(0);
  const [moving, setMoving] = useState<{ path: string; name: string; root?: string } | null>(null);
  const [moveError, setMoveError] = useState("");

  const activeRoots: (string | undefined)[] = roots && roots.length ? roots : [undefined];

  const handleMove = async (destination: string) => {
    if (!moving) return;
    try {
      await moveWorkspaceFile(moving.path, destination, moving.root);
      setMoveError("");
      setTreeVersion((version) => version + 1);
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error));
    } finally {
      setMoving(null);
    }
  };

  return (
    <div className="file-tree">
      {moveError && <div className="ft-hint err">⚠ {moveError}</div>}
      {activeRoots.map((root) => (
        <RootTree
          key={root ?? ""}
          root={root}
          treeVersion={treeVersion}
          onPickFile={onPickFile}
          onPreview={onPreview}
          onPickDir={onPickDir}
          onMoveFile={(path, r) => setMoving({ path, name: path.split("/").pop() ?? path, root: r })}
        />
      ))}
      {moving && (
        <DirPicker
          title="选择移动目标文件夹"
          initialPath={rootPath}
          onSelect={(destination) => void handleMove(destination)}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}