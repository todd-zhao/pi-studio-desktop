import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { listCommands, listWorkspaceFiles, uploadFiles } from "../api";
import type { AttachmentInfo, CommandInfo } from "../types";

export interface ComposerHandle {
  insertText: (text: string) => void;
}

interface Props {
  isStreaming: boolean;
  modelName?: string;
  onSend: (text: string, attachments?: AttachmentInfo[], refs?: string[]) => void;
  onAbort: () => void;
  onError: (message: string) => void;
}

interface CompletionItem {
  label: string;
  detail?: string;
  isDir?: boolean;
  insert: string;
}

interface CompletionState {
  kind: "command" | "file";
  start: number; // index of the trigger char within the line
  token: string; // text after the trigger char (may be empty)
  items: CompletionItem[];
  selected: number;
  loadKey: number; // increments to retrigger async load
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "🖼";
  if (["pdf"].includes(ext)) return "📄";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "🗜";
  if (["py", "ts", "tsx", "js", "jsx", "go", "rs", "java", "c", "cpp", "rb"].includes(ext)) return "📜";
  if (["xlsx", "xls", "csv"].includes(ext)) return "📊";
  if (["doc", "docx", "txt", "md"].includes(ext)) return "📝";
  return "📎";
}

// Extract `@path` references from a message for backend prompt refs.
function extractRefs(text: string): string[] {
  const out: string[] = [];
  const re = /@([^\s@，。；：,;:"'`()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = m[1];
    if (/^[A-Za-z]:[\\/]/.test(p)) continue; // absolute Windows path → not a ref
    if (p.startsWith("/")) continue;
    if (p.includes("://")) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { isStreaming, modelName, onSend, onAbort, onError }: Props,
  ref,
) {
  const visibleModelName = modelName && !/^unknown(?:[/]unknown)?$/i.test(modelName) ? modelName : "";
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [completion, setCompletion] = useState<CompletionState | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const commandsRef = useRef<CommandInfo[]>([]);
  const completionRef = useRef<CompletionState | null>(null);
  completionRef.current = completion;
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    void listCommands()
      .then((cmds) => (commandsRef.current = cmds))
      .catch(() => {
        commandsRef.current = [];
      });
  }, []);

  // Insert text at the cursor (used by the file tree to add @references).
  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      const ta = taRef.current;
      const cur = textRef.current;
      const selStart = ta?.selectionStart ?? cur.length;
      const before = cur.slice(0, selStart);
      const after = cur.slice(selStart);
      const sep = before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
      const next = before + sep + text + " " + after;
      setText(next);
      requestAnimationFrame(() => {
        if (ta) {
          ta.focus();
          const pos = before.length + sep.length + text.length;
          ta.setSelectionRange(pos, pos);
          autoGrow();
        }
      });
    },
  }));

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  };

  const insertCompletion = useCallback((item: CompletionItem, state: CompletionState) => {
    const ta = taRef.current;
    const cur = textRef.current;
    const selStart = ta?.selectionStart ?? cur.length;
    // locate the completion token start: from the line start up to selStart
    const lineStart = cur.lastIndexOf("\n", selStart - 1) + 1;
    const start = lineStart + state.start;
    const before = cur.slice(0, start);
    const after = cur.slice(selStart);
    const insert = item.insert + (item.isDir ? "" : " ");
    const next = before + insert + after;
    setText(next);
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        const pos = start + insert.length;
        ta.setSelectionRange(pos, pos);
        autoGrow();
      }
    });
    setCompletion(null);
  }, []);

  // Analyze the current token for completion triggers.
  const analyze = useCallback(
    (value: string, selStart: number) => {
      const lineStart = value.lastIndexOf("\n", selStart - 1) + 1;
      const lineBefore = value.slice(lineStart, selStart);
      const m = lineBefore.match(/(^|\s)([/@])([^\s]*)$/);
      if (!m) {
        setCompletion(null);
        return;
      }
      const trigger = m[2];
      const token = m[3] ?? "";
      const triggerIndex = lineBefore.length - (m[3]?.length ?? 0) - 1;

      if (trigger === "/") {
        // command completion
        const cmds = commandsRef.current;
        const filtered = cmds
          .filter((c) => c.name.replace(/^\//, "").startsWith(token.toLowerCase()) || c.name.toLowerCase().includes(token.toLowerCase()))
          .slice(0, 12)
          .map<CompletionItem>((c) => ({
            label: c.name,
            detail: c.description,
            insert: c.name,
          }));
        setCompletion(
          filtered.length
            ? { kind: "command", start: triggerIndex, token, items: filtered, selected: 0, loadKey: 0 }
            : null,
        );
        return;
      }

      if (trigger === "@") {
        // file completion
        const slash = token.lastIndexOf("/");
        const dir = slash >= 0 ? token.slice(0, slash + 1) : "";
        const namePart = slash >= 0 ? token.slice(slash + 1) : token;
        setCompletion((prev) => {
          if (prev?.kind === "file" && prev.token === token) return prev;
          return { kind: "file", start: triggerIndex, token, items: [], selected: 0, loadKey: (prev?.loadKey ?? 0) + 1 };
        });
      }
    },
    [],
  );

  // Async file listing for @ completions.
  useEffect(() => {
    const comp = completionRef.current;
    if (!comp || comp.kind !== "file") return;
    const token = comp.token;
    const slash = token.lastIndexOf("/");
    const dir = slash >= 0 ? token.slice(0, slash) : "";
    const namePart = slash >= 0 ? token.slice(slash + 1) : token;
    const timer = window.setTimeout(() => {
      listWorkspaceFiles(dir)
        .then((entries) => {
          const cur = completionRef.current;
          if (!cur || cur.kind !== "file" || cur.token !== token) return;
          const filtered = entries
            .filter((e) => e.name.toLowerCase().startsWith(namePart.toLowerCase()))
            .slice(0, 20)
            .map<CompletionItem>((e) => ({
              label: e.isDir ? `${e.name}/` : e.name,
              detail: e.isDir ? "目录" : `${fmtSize(e.size)}`,
              isDir: e.isDir,
              insert: `@${dir ? `${dir}/` : ""}${e.name}${e.isDir ? "/" : ""}`,
            }));
          setCompletion({ ...cur, items: filtered, selected: 0 });
        })
        .catch(() => {
          setCompletion(null);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [completion?.kind, completion?.token, completion?.loadKey]);

  const handleChange = (value: string) => {
    setText(value);
    autoGrow();
    const selStart = taRef.current?.selectionStart ?? value.length;
    analyze(value, selStart);
  };

  const confirmCompletion = () => {
    const comp = completionRef.current;
    if (!comp || comp.items.length === 0) return false;
    const item = comp.items[comp.selected] ?? comp.items[0];
    insertCompletion(item, comp);
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const comp = completionRef.current;
    if (comp && comp.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCompletion({ ...comp, selected: (comp.selected + 1) % comp.items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCompletion({ ...comp, selected: (comp.selected - 1 + comp.items.length) % comp.items.length });
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        confirmCompletion();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        confirmCompletion();
        return;
      }
      if (e.key === "Escape") {
        setCompletion(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const handleFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    try {
      const files = await uploadFiles(Array.from(list));
      setAttachments((prev) => [...prev, ...files]);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const send = () => {
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    const refs = extractRefs(text);
    onSend(t, attachments, refs);
    setText("");
    setAttachments([]);
    setCompletion(null);
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const canSend = text.trim().length > 0 || attachments.length > 0;
  const comp = completion;

  return (
    <div className="composer-wrap">      <div className="composer">
        {attachments.length > 0 && (
          <div className="composer-attach">
            {attachments.map((a) => (
              <div key={a.path} className="attach-preview">
                {a.data && a.mediaType.startsWith("image/") ? (
                  <img src={`data:${a.mediaType};base64,${a.data}`} alt={a.name} />
                ) : (
                  <span style={{ fontSize: "16px" }}>{fileIcon(a.name)}</span>
                )}
                <span style={{ maxWidth: "150px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.name}
                </span>
                <span className="x" onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))} title="移除">
                  ✕
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="composer-input" style={{ position: "relative" }}>
          {comp && comp.items.length > 0 && (
            <div className="completion-pop" onMouseDown={(e) => e.preventDefault()}>
              <div className="completion-title">{comp.kind === "command" ? "命令" : "文件"}</div>
              {comp.items.map((it, i) => (
                <div
                  key={it.label}
                  className={`completion-item ${i === comp.selected ? "sel" : ""}`}
                  onMouseEnter={() => setCompletion({ ...comp, selected: i })}
                  onClick={() => insertCompletion(it, comp)}
                >
                  <span className="ci-label">{it.label}</span>
                  {it.detail && <span className="ci-detail">{it.detail}</span>}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={1}
            placeholder="给 Pi 发消息"
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <input
            ref={fileRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button className="icon-btn" title="上传文件/图片" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <span className="spinner" /> : "📎"}
          </button>
          {isStreaming ? (
            <button className="stop-btn" title="停止" onClick={onAbort}>
              ■
            </button>
          ) : (
            <button className="send-btn" title="发送" disabled={!canSend} onClick={send}>
              ↑
            </button>
          )}
        </div>
        {(visibleModelName || uploading) && (
          <div className="composer-hint">
            {visibleModelName && <span>{visibleModelName}</span>}
            {uploading && <span className="uploading">上传中…</span>}
          </div>
        )}
      </div>
    </div>
  );
});

function fmtSize(size?: number): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
