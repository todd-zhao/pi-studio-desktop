import { useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../types";
import { LiveToolCallCard, Message } from "./Message";
import { Markdown } from "./markdown";
import type { QueuedItem, RenderedMessage } from "../App";

interface LiveState {
  liveText: string;
  liveThinking: string;
  liveTools: Array<{ key: string; name: string; status: "running" | "done" | "error"; args?: string; output?: string }>;
}

interface Props {
  messages: RenderedMessage[];
  live: LiveState;
  queued: QueuedItem[] | null;
  isStreaming: boolean;
  onCancelQueued: (kind: "steer" | "followUp", text: string) => void;
  onEditQueued: (kind: "steer" | "followUp", oldText: string, newText: string) => void;
  onSaveMemory?: (message: RenderedMessage) => void;
  canSaveMemory?: boolean;
}

export function Chat({ messages, live, queued, isStreaming, onCancelQueued, onEditQueued, onSaveMemory, canSaveMemory }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState(true);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const showEmpty = messages.length === 0 && !isStreaming && !live.liveText;

  useEffect(() => {
    if (stickBottom) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [messages, live, queued, stickBottom]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setStickBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const jumpToStart = () => {
    ref.current?.scrollTo({ top: 0, behavior: "smooth" });
  };
  const jumpToEnd = () => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      {!showEmpty && (
        <div className="chat-jump-top-wrap">
          <button type="button" className="chat-jump-btn chat-jump-top" title="跳到对话开头" onClick={jumpToStart}>↑</button>
        </div>
      )}
      <div className="chat-inner">
        {showEmpty && (
          <div className="chat-empty">
            <div className="hero">
              <h1 className="hero-title">Pi Studio</h1>
            </div>
          </div>
        )}

        {messages.map((m) => (
          <Message key={m.id} msg={m} onSaveMemory={onSaveMemory} canSaveMemory={canSaveMemory} />
        ))}

        {queued && queued.length > 0 && (
          <div className="queued-bar">
            <div className="queued-title">消息队列</div>
            {queued.map((item, index) => (
              <div className="queued-item" key={`${item.kind}-${item.text}-${index}`}>
                <span className={`queued-kind ${item.kind}`}>{item.kind === "steer" ? "干预" : "后续"}</span>
                {editingIndex === index ? (
                  <input
                    className="queued-edit"
                    value={editingText}
                    autoFocus
                    onChange={(e) => setEditingText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (editingText.trim()) onEditQueued(item.kind, item.text, editingText);
                        setEditingIndex(null);
                      } else if (e.key === "Escape") {
                        setEditingIndex(null);
                      }
                    }}
                  />
                ) : (
                  <span className="queued-text">{item.text}</span>
                )}
                {editingIndex === index ? (
                  <>
                    <button
                      className="queued-action"
                      disabled={!editingText.trim()}
                      onClick={() => {
                        if (editingText.trim()) onEditQueued(item.kind, item.text, editingText);
                        setEditingIndex(null);
                      }}
                    >
                      保存
                    </button>
                    <button className="queued-action" onClick={() => setEditingIndex(null)}>取消</button>
                  </>
                ) : (
                  <>
                    <button
                      className="queued-action"
                      onClick={() => {
                        setEditingIndex(index);
                        setEditingText(item.text);
                      }}
                    >
                      修改
                    </button>
                    <button className="queued-action danger" onClick={() => onCancelQueued(item.kind, item.text)}>取消</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {isStreaming && (
          <div className="msg-assistant">
            <div className="assistant-head">
              <span>Pi</span>
              <span className="badge">思考中…</span>
            </div>
            {live.liveTools.length > 0 && (
              <details className="tool-calls-group">
                <summary>
                  <span className="tool-calls-title">{"\u5de5\u5177\u8c03\u7528"}</span>
                  <span className="tool-calls-count">{live.liveTools.length}</span>
                  {live.liveTools.some((tool) => tool.status === "running") && (
                    <span className="tool-calls-state">{"\u8fd0\u884c\u4e2d"}</span>
                  )}
                  {live.liveTools.some((tool) => tool.status === "error") && (
                    <span className="tool-calls-state error">{"\u6709\u5931\u8d25"}</span>
                  )}
                </summary>
                <div className="tool-calls-list">
                  {live.liveTools.map((tool) => (
                    <LiveToolCallCard key={tool.key} tool={tool} />
                  ))}
                </div>
              </details>
            )}
            {live.liveThinking && (
              <div className="thinking">
                <details>
                  <summary>💭 思考过程（{live.liveThinking.length} 字）</summary>
                  <div className="thinking-body">{live.liveThinking}</div>
                </details>
              </div>
            )}
            {live.liveText && (
              <div className="msg-body">
                <Markdown text={live.liveText} />
                <span className="live-cursor" aria-hidden="true" />
              </div>
            )}
            {!live.liveText && !live.liveThinking && live.liveTools.length === 0 && (
              <div className="empty-inline">正在等待响应…</div>
            )}
          </div>
        )}
      </div>

      {!showEmpty && (
        <div className="chat-jump-bottom-wrap">
          <button type="button" className="chat-jump-btn chat-jump-bottom" title="跳到对话结尾" onClick={jumpToEnd}>↓</button>
        </div>
      )}
    </div>
  );
}
