import { useCallback, useEffect, useState } from "react";
import { getEnvironment, listDirs } from "../api";
import type { FileEntry } from "../types";

interface Props {
  initialPath?: string;
  title?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

let homeCache = "";
async function getHome(): Promise<string> {
  if (homeCache) return homeCache;
  try {
    const j = await getEnvironment();
    homeCache = j.home ?? "";
  } catch {
    /* ignore */
  }
  return homeCache;
}

function fmtPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function DirPicker({ initialPath, title = "选择工作区目录", onSelect, onClose }: Props) {
  const [path, setPath] = useState(initialPath ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [input, setInput] = useState(path);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError("");
    try {
      const list = await listDirs(p);
      setEntries(list);
      setPath(p);
      setInput(p);
    } catch (e) {
      setError((e as Error).message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialPath ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enter = (entry: FileEntry) => {
    void load(entry.path);
  };

  const goUp = () => {
    if (!path) return;
    if (/^[A-Za-z]:\\?$/.test(path)) {
      void load("");
      return;
    }
    const parent = path.replace(/\\$/, "").split(/[\\/]/).slice(0, -1).join("\\");
    if (!parent || parent.length < 2) {
      void load("");
      return;
    }
    void load(parent.endsWith(":") ? parent + "\\" : parent);
  };

  const home = () => {
    void getHome().then((h) => {
      if (h) void load(h);
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: "min(560px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="nm">{title}</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div className="market-search">
            <input
              placeholder="输入完整路径，回车跳转（如 D:/projects/xxx）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim()) void load(input.trim());
              }}
            />
            <button className="btn" onClick={() => void load(input.trim() || "")}>
              跳转
            </button>
            <button className="btn" onClick={goUp} title="上级目录">
              ↑
            </button>
          </div>

          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: "11px", color: "var(--text-3)" }}>当前位置：</span>
            <code style={{ fontSize: "12px", color: "var(--text-2)", wordBreak: "break-all" }}>{path || "（磁盘列表）"}</code>
          </div>

          {error && <div style={{ color: "var(--red)", fontSize: "12px" }}>⚠ {error}</div>}
          {loading && <div style={{ color: "var(--text-3)", fontSize: "12px" }}>加载中…</div>}

          <div style={{ border: "1px solid var(--border)", borderRadius: "8px", maxHeight: "300px", overflowY: "auto", background: "var(--bg-3)" }}>
            {!loading &&
              entries.map((e) => (
                <div
                  key={e.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "6px 10px",
                    cursor: "pointer",
                    fontSize: "13px",
                    borderBottom: "1px solid var(--border)",
                  }}
                  onClick={() => enter(e)}
                  onDoubleClick={() => {
                    if (e.isDir) enter(e);
                  }}
                >
                  <span>📁</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                  <span style={{ color: "var(--text-3)", fontSize: "11px" }}>目录</span>
                </div>
              ))}
            {!loading && !error && entries.length === 0 && (
              <div style={{ padding: "16px", color: "var(--text-3)", fontSize: "12px", textAlign: "center" }}>该目录下没有子目录</div>
            )}
          </div>

          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <button className="mini-btn" onClick={home} title="用户主目录">
              🏠 用户目录
            </button>
            <span style={{ fontSize: "11px", color: "var(--text-3)" }}>单击进入目录，双击展开，路径栏可手动输入</span>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!path}
            onClick={() => onSelect(path)}
            title={`选择 ${path}`}
          >
            选择此目录
          </button>
        </div>
      </div>
    </div>
  );
}
