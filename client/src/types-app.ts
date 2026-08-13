import { useMemo } from "react";
import type { ClientMessage } from "./types";

// ---------------------------------------------------------------------------
// Shared client types (extracted from the old App.tsx god component).
// Re-exported from App.tsx so existing component imports keep working.
// ---------------------------------------------------------------------------

export interface LiveTool {
  key: string;
  name: string;
  status: "running" | "done" | "error";
  args?: string;
  output?: string;
}

export interface QueuedItem {
  kind: "steer" | "followUp";
  text: string;
}

export interface LiveSnapshot {
  text: string;
  thinking: string;
  tools: LiveTool[];
  queued: QueuedItem[] | null;
}

export function emptyLiveSnapshot(): LiveSnapshot {
  return { text: "", thinking: "", tools: [], queued: null };
}

export function sessionKey(sessionId?: string): string {
  return sessionId ? "id:" + sessionId : "unknown";
}

export function storedPaneWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    if (Number.isFinite(value)) return Math.min(max, Math.max(min, value));
  } catch {
    /* ignore unavailable storage */
  }
  return fallback;
}

export function buildOneShotGoal(mainText: string, supplementalText: string): string {
  const main = mainText.trim() || "\u6839\u636e\u672c\u6b21\u5bf9\u8bdd\u5185\u5bb9\u5b8c\u6210\u4efb\u52a1";
  const supplemental = supplementalText.trim();
  return [
    `\u672c\u6b21\u957f\u65f6\u4efb\u52a1\uFF1A\n${main}`,
    supplemental ? `\u8865\u5145\u7ea6\u675f/\u9a8c\u6536\u6807\u51c6\uFF1A\n${supplemental}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface Toast {
  id: number;
  level: "info" | "warn" | "error" | "ok";
  message: string;
}

export interface RenderedMessage extends ClientMessage {
  toolResults?: Record<string, { text: string; isError: boolean }>;
}

export type PanelTab = "mcp" | "models" | "skills" | "agents" | "team" | "schedules" | "wechat" | "projects" | "archived";

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

export function formatResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function useMemoMessages(messages: ClientMessage[]): RenderedMessage[] {
  // attach toolResult messages to their owning assistant toolCall (as output)
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolCallId) {
      results.set(m.toolCallId, { text: m.text, isError: !!m.isError });
    }
  }

  return useMemo(
    () =>
      messages
        .filter((m) => m.role !== "toolResult")
        .map((m) => {
          if (m.role === "assistant" && m.toolCalls?.length) {
            const toolResults: Record<string, { text: string; isError: boolean }> = {};
            for (const c of m.toolCalls) {
              const r = results.get(c.id);
              if (r) toolResults[c.id] = r;
            }
            return { ...m, toolResults };
          }
          return { ...m };
        }),
    // `results` is rebuilt per render; the filtered/mapped output only depends on `messages`.
    [messages],
  );
}
