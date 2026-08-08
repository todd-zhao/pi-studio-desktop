import { useEffect, useRef, useState } from "react";
import type { ClientMessage } from "../types";
import { LiveToolCallCard, Message } from "./Message";
import { Markdown } from "./markdown";
import type { RenderedMessage } from "../App";

interface LiveState {
  liveText: string;
  liveThinking: string;
  liveTools: Array<{ key: string; name: string; status: "running" | "done" | "error"; args?: string; output?: string }>;
}

interface Props {
  messages: RenderedMessage[];
  live: LiveState;
  queued: { steering: number; followUp: number } | null;
  isStreaming: boolean;
}

export function Chat({ messages, live, queued, isStreaming }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState(true);
  const showEmpty = messages.length === 0 && !isStreaming && !live.liveText;

  useEffect(() => {
    if (stickBottom) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [messages, live, queued, stickBottom]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setStickBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  return (
    <div className="chat" ref={ref} onScroll={onScroll}>
      <div className="chat-inner">
        {showEmpty && (
          <div className="chat-empty">
            <div className="hero">
              <h1 className="hero-title">Pi Studio</h1>
            </div>
          </div>
        )}

        {messages.map((m) => (
          <Message key={m.id} msg={m} />
        ))}

        {queued && (queued.steering > 0 || queued.followUp > 0) && (
          <div className="queued-bar">
            ⏳ 队列中：{queued.steering > 0 ? `${queued.steering} 条干预` : ""}
            {queued.followUp > 0 ? `${queued.followUp} 条后续` : ""}
          </div>
        )}

        {isStreaming && (
          <div className="msg-assistant">
            <div className="assistant-head">
              <span>Pi</span>
              <span className="badge">思考中…</span>
            </div>
            {live.liveTools.map((t) => (
              <LiveToolCallCard key={t.key} tool={t} />
            ))}
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
    </div>
  );
}
