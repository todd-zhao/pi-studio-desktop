import type {
  WechatCommandAction,
  WechatLogEntry,
  WechatQr,
  WechatStatus,
} from "../types";

import { PanelShell } from "./PanelShell";

interface Props {
  status: WechatStatus | null;
  qr: WechatQr | null;
  logs: WechatLogEntry[];
  onCommand: (action: WechatCommandAction) => void;
  onClose: () => void;
}

const PHASE_LABEL: Record<WechatStatus["phase"], string> = {
  idle: "未连接",
  connecting: "连接中",
  qr: "等待扫码",
  scanned: "已扫码",
  expired: "二维码过期",
  connected: "已连接",
  error: "连接异常",
};

const DIRECTION_LABEL: Record<WechatLogEntry["direction"], string> = {
  in: "收",
  out: "发",
  system: "系统",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function WechatPanel({ status, qr, logs, onCommand, onClose }: Props) {
  const phase = status?.phase ?? "idle";
  const showQr = !!qr && phase !== "idle" && phase !== "connected";

  return (
    <div className="wechat-panel">
      <PanelShell variant="wechat" title="微信对话" subtitle="手机微信直连 Pi" onClose={onClose} />

      <div className="wechat-body">
        <div className={`wechat-status wechat-status-${phase}`}>
          <div className="wechat-status-top">
            <span className={`wechat-dot wechat-dot-${phase}`} />
            <strong>{PHASE_LABEL[phase]}</strong>
            {status?.account && <code className="wechat-account">{status.account}</code>}
            <span className="wechat-time">{status ? fmtTime(status.timestamp) : ""}</span>
          </div>
          {status?.message && <div className="wechat-status-msg">{status.message}</div>}
        </div>

        <div className="wechat-actions">
          <button
            className="btn primary"
            disabled={phase === "connecting" || phase === "scanned" || phase === "connected"}
            onClick={() => onCommand("connect")}
          >
            连接
          </button>
          <button
            className="btn"
            disabled={phase === "connecting" || phase === "scanned"}
            onClick={() => onCommand("reconnect")}
          >
            重新连接
          </button>
          <button
            className="btn wechat-danger"
            disabled={phase === "idle"}
            onClick={() => onCommand("disconnect")}
          >
            断开
          </button>
        </div>

        {showQr && qr && (
          <div className="wechat-qr-card">
            <img src={qr.data} alt="微信登录二维码" />
            <div className="wechat-qr-hint">
              {phase === "expired" ? "二维码已过期，等待新二维码" : "使用微信扫描二维码"}
            </div>
          </div>
        )}

        <div className="wechat-log-head">
          <span className="panel-title">消息记录</span>
          <span className="wechat-log-count">{logs.length}</span>
        </div>
        <div className="wechat-log-list">
          {logs.length === 0 && <div className="wechat-log-empty">暂无记录</div>}
          {logs.map((entry) => (
            <div key={entry.id} className={`wechat-log-item wechat-log-${entry.direction}`}>
              <div className="wechat-log-meta">
                <span className={`wechat-log-dir wechat-log-dir-${entry.direction}`}>
                  {DIRECTION_LABEL[entry.direction]}
                </span>
                <span className="wechat-log-time">{fmtTime(entry.timestamp)}</span>
              </div>
              <div className="wechat-log-text">{entry.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
