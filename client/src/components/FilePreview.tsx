import { useEffect, useRef, useState } from "react";
import { authenticatedUrl, readWorkspaceFile, parseWorkspaceFile } from "../api";
import type { ParsedDoc, WorkspaceFileContent } from "../types";
import { Markdown } from "./markdown";

interface Props {
  file: { path: string; name: string };
  onClose: () => void;
  onInsertRef: (path: string) => void;
}

function fmtSize(size?: number): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Minimal CSV parser (handles quoted fields / embedded commas & quotes). */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      cur.push(field);
      field = "";
    } else if (ch === "\n") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  return rows;
}

function DataTable({ rows, maxRows = 200, maxCols = 30 }: { rows: string[][]; maxRows?: number; maxCols?: number }) {
  const shown = rows.slice(0, maxRows);
  const cols = Math.min(maxCols, ...shown.map((r) => r.length));
  if (shown.length === 0) return <div className="ft-hint">（空表格）</div>;
  return (
    <div className="md-table-wrap">
      <table className="data-table">
        <tbody>
          {shown.map((row, ri) => (
            <tr key={ri}>
              {Array.from({ length: cols }, (_, ci) =>
                ri === 0 ? <th key={ci}>{row[ci] ?? ""}</th> : <td key={ci}>{row[ci] ?? ""}</td>,
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > maxRows && (
        <div className="preview-truncated-inline">…共 {rows.length} 行，仅显示前 {maxRows} 行</div>
      )}
    </div>
  );
}

export function FilePreview({ file, onClose, onInsertRef }: Props) {
  const [data, setData] = useState<WorkspaceFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [parsed, setParsed] = useState<ParsedDoc | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | null>(null);

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const isDoc = ext === "docx" || ext === "xlsx" || ext === "xls" || ext === "pptx";

  useEffect(() => {
    if (isDoc) {
      setLoading(false);
      setData(null);
      setError("");
      setParsing(true);
      setParsed(null);
      setParseError("");
      parseWorkspaceFile(file.path)
        .then(setParsed)
        .catch((e) => setParseError((e as Error).message))
        .finally(() => setParsing(false));
    } else {
      setParsing(false);
      setParsed(null);
      setParseError("");
      setLoading(true);
      setError("");
      setData(null);
      readWorkspaceFile(file.path)
        .then(setData)
        .catch((e) => setError((e as Error).message))
        .finally(() => setLoading(false));
    }
  }, [file.path, file.name, isDoc]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const close = () => {
    if (closing) return;
    setClosing(true);
    timer.current = window.setTimeout(onClose, 200);
  };

  const isPdf = ext === "pdf" || data?.mime === "application/pdf";
  const isHtml = ext === "html" || ext === "htm";
  const isImage = !!data && !data.isBinary && data.mime.startsWith("image/");
  const isMarkdown = !!data && !data.isBinary && (data.mime === "text/markdown" || ext === "md" || ext === "markdown");
  const isCsv = ext === "csv" && !!data && !data.isBinary;
  const rawUrl = data ? authenticatedUrl(`/api/workspace/file/raw?path=${encodeURIComponent(data.path)}`) : "";
  const htmlUrl = isHtml && data ? authenticatedUrl(`/api/workspace/preview/${data.path.split("/").map(encodeURIComponent).join("/")}`) : "";
  const imgSrc = data?.content ?? (isImage ? rawUrl : undefined);
  const csv = isCsv ? csvRows(data?.content ?? "") : [];

  return (
    <div className={`preview-panel ${closing ? "closing" : ""}`}>
      <div className="preview-head">
        <span className="preview-name" title={file.path}>
          {file.name}
        </span>
        <span className="preview-path" title={file.path}>
          {file.path}
        </span>
        <span className="preview-actions">
          <button className="mini-btn" title="在输入框插入 @引用" onClick={() => onInsertRef(file.path)}>
            @ 引用
          </button>
          <button className="icon-btn" title="折叠到右侧" onClick={close}>
            »
          </button>
        </span>
      </div>
      <div className="preview-body">
        {loading && <div className="ft-hint">加载中…</div>}
        {error && <div className="ft-hint err">⚠ {error}</div>}
        {data?.truncated && (
          <div className="preview-truncated">
            ⚠ 文件较大（共 {fmtSize(data.size)}），仅显示前 {fmtSize(1024 * 1024)}…
          </div>
        )}
        {isPdf && <iframe className="preview-pdf" src={rawUrl} title={file.name} />}
        {isHtml && htmlUrl && <iframe className="preview-html" src={htmlUrl} sandbox="allow-scripts allow-same-origin allow-popups" referrerPolicy="no-referrer" title={file.name} />}
        {isImage && (
          <div className="preview-img">
            <img src={imgSrc} alt={file.name} />
          </div>
        )}
        {isMarkdown && (
          <div className="preview-md">
            <Markdown text={data.content ?? ""} />
          </div>
        )}
        {isDoc && parsing && <div className="ft-hint">解析中…</div>}
        {isDoc && parseError && <div className="ft-hint err">⚠ {parseError}</div>}
        {parsed?.kind === "docx" && <div className="preview-doc" dangerouslySetInnerHTML={{ __html: parsed.html ?? "" }} />}
        {parsed?.kind === "pptx" && <div className="preview-pptx" dangerouslySetInnerHTML={{ __html: parsed.html ?? "" }} />}
        {parsed?.kind === "xlsx" &&
          (parsed.sheets ?? []).map((s) => (
            <div key={s.name} className="xlsx-sheet">
              <div className="xlsx-sheet-name">📊 {s.name}</div>
              <DataTable rows={s.rows} maxRows={500} maxCols={60} />
            </div>
          ))}
        {isCsv && <DataTable rows={csv} />}
        {!isDoc && !isPdf && !isHtml && data && !data.isBinary && !isImage && !isMarkdown && !isCsv && (
          <pre className="preview-code">{data.content}</pre>
        )}
        {!isDoc && !isPdf && data && data.isBinary && (
          <div className="preview-binary">
            <div>⚠ 二进制文件，无法预览文本内容</div>
            <div className="preview-meta">
              {data.name} · {fmtSize(data.size)} · {data.mime}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
