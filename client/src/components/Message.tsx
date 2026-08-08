import { useState } from "react";
import type { ToolCallInfo } from "../types";
import type { RenderedMessage } from "../App";
import { Markdown } from "./markdown";

function fmtTs(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function firstLine(text: string, max = 70): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

export function ToolCallCard({ call, result }: { call: ToolCallInfo; result?: { text: string; isError: boolean } }) {
  const [open, setOpen] = useState(false);
  const done = result !== undefined;
  const err = result?.isError;
  const summary = done ? firstLine(result.text) : "";

  return (
    <div
      className={`tool-call ${!done ? "running" : err ? "error" : ""}`}
      onClick={() => setOpen(!open)}
      title="点击展开/收起详情"
    >
      <div className="tool-call-head">
        <span>{open ? "▾" : "▸"}</span>
        <span className="tname">{call.name}</span>
        {!done && <span className="spinner" />}
        {done && summary && !open && <span className="t-summary">{summary}</span>}
        <span className="tstate">{!done ? "运行中" : err ? "失败" : "完成"}</span>
      </div>
      {open && (
        <div className="tool-call-body">
          {call.arguments && Object.keys(call.arguments).length > 0 && (
            <div className="args">{JSON.stringify(call.arguments, null, 2)}</div>
          )}
          {done && <pre className={err ? "err" : ""}>{result.text || "(无输出)"}</pre>}
        </div>
      )}
    </div>
  );
}

export function LiveToolCallCard({ tool }: { tool: { name: string; status: "running" | "done" | "error"; args?: string; output?: string } }) {
  const [open, setOpen] = useState(false);
  const done = tool.status !== "running";
  const err = tool.status === "error";

  return (
    <div
      className={`tool-call ${tool.status === "running" ? "running" : err ? "error" : ""}`}
      onClick={() => setOpen((value) => !value)}
      title="点击展开/收起工具详情"
    >
      <div className="tool-call-head">
        <span>{open ? "▾" : "▸"}</span>
        <span className="tname">{tool.name}</span>
        {!done && <span className="spinner" />}
        <span className="tstate">{tool.status === "running" ? "运行中" : err ? "失败" : "完成"}</span>
      </div>
      {open && (
        <div className="tool-call-body">
          {tool.args && <pre className="args">{tool.args}</pre>}
          {tool.output && <pre className={err ? "err" : ""}>{tool.output}</pre>}
        </div>
      )}
    </div>
  );
}
function ToolCallGroup({
  calls,
  results,
}: {
  calls: ToolCallInfo[];
  results?: Record<string, { text: string; isError: boolean }>;
}) {
  const running = calls.filter((call) => !results?.[call.id]).length;
  const failed = calls.filter((call) => results?.[call.id]?.isError).length;

  return (
    <details className="tool-calls-group">
      <summary>
        <span className="tool-calls-title">{"\u5de5\u5177\u8c03\u7528"}</span>
        <span className="tool-calls-count">{calls.length}</span>
        {running > 0 && <span className="tool-calls-state">{"\u8fd0\u884c\u4e2d"}</span>}
        {failed > 0 && (
          <span className="tool-calls-state error">
            {failed} {"\u5931\u8d25"}
          </span>
        )}
      </summary>
      <div className="tool-calls-list">
        {calls.map((call) => (
          <ToolCallCard key={call.id} call={call} result={results?.[call.id]} />
        ))}
      </div>
    </details>
  );
}

interface MessageProps {
  msg: RenderedMessage;
  onSaveMemory?: (message: RenderedMessage) => void;
  canSaveMemory?: boolean;
}

export function Message({ msg, onSaveMemory, canSaveMemory }: MessageProps) {
  if (msg.role === "user") {
    return (
      <div className="msg-user">
        <div className="bubble">
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="msg-attach">
              {msg.attachments.map((a) => (
                <span key={a.path} className="attach-chip">
                  <span>📎</span>
                  <span className="nm">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {msg.text}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="msg-assistant">
      <div className="assistant-head">
        <span>Pi</span>
        {msg.isError && <span className="badge" style={{ color: "var(--red)", borderColor: "var(--red)" }}>出错</span>}
        <span style={{ marginLeft: "auto" }}>{fmtTs(msg.timestamp)}</span>
      </div>

      {msg.thinking && (
        <div className="thinking">
          <details>
            <summary>
              💭 思考过程{msg.thinking.length > 0 ? `（${msg.thinking.length} 字）` : ""}
            </summary>
            <div className="thinking-body">{msg.thinking}</div>
          </details>
        </div>
      )}

      {msg.errorMessage && <div className="msg-error">⚠ {msg.errorMessage}</div>}

      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <ToolCallGroup calls={msg.toolCalls} results={msg.toolResults} />
      )}

      {msg.text && (
        <div className="msg-body">
          <Markdown text={msg.text} />
        </div>
      )}

      {canSaveMemory && msg.text && (
        <button className="message-action" type="button" onClick={() => onSaveMemory?.(msg)}>保存为项目记忆</button>
      )}

      {!msg.text && !msg.thinking && !msg.errorMessage && (msg.toolCalls?.length ?? 0) === 0 && (
        <div className="empty-inline">（空响应）</div>
      )}
    </div>
  );
}
