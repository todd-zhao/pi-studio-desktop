import { useState } from "react";
import type { ArchivedSession } from "../types";
import { PanelShell } from "./PanelShell";

interface Props {
  sessions: ArchivedSession[];
  onRestore: (file: string) => void;
  onDelete: (file: string) => void;
  onClose: () => void;
}

function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ArchivedSessionsPanel({ sessions, onRestore, onDelete, onClose }: Props) {
  const [confirmingFile, setConfirmingFile] = useState<string | null>(null);

  return (
    <PanelShell variant="head" className="archived-panel" title="已归档对话" hint="归档的对话不会出现在普通会话列表中，可在此还原或删除。" onClose={onClose}>
      {sessions.length === 0 ? (
        <div className="panel-empty">暂无已归档对话</div>
      ) : (
        <div className="archived-list">
          {sessions.map((session) => (
            <div className="archived-card" key={session.file}>
              <strong className="archived-name" title={session.name || session.firstMessage || session.file}>
                {session.name || session.firstMessage || session.file.split(/[\\/]/).pop()}
              </strong>
              <small>
                {session.messageCount} 条消息 · 归档于 {fmtTime(session.archivedAt)}
                {session.projectName ? ` · ${session.projectName}` : ""}
              </small>
              <div className="archived-actions">
                <button className="mini-btn" onClick={() => onRestore(session.file)}>还原</button>
                <button
                  className={`mini-btn danger${confirmingFile === session.file ? " confirming" : ""}`}
                  onClick={() => {
                    if (confirmingFile === session.file) {
                      setConfirmingFile(null);
                      onDelete(session.file);
                    } else {
                      setConfirmingFile(session.file);
                      window.setTimeout(() => setConfirmingFile((current) => current === session.file ? null : current), 3000);
                    }
                  }}
                >
                  {confirmingFile === session.file ? "确认删除" : "删除"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}
