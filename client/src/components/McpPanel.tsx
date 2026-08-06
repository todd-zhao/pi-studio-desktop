import { useState } from "react";
import { addMcpServer, addMcpServersBatch, getMcpConfig, removeMcpServer } from "../api";
import type { McpStatusSnapshot } from "../types";

interface Props {
  mcp: McpStatusSnapshot | null;
  onCommand: (command: string) => void;
  onClose: () => void;
  onToast: (level: "info" | "warn" | "error" | "ok", message: string) => void;
}

const FAILED_HINTS: Record<string, string> = {
  "not-connected": "惰性连接：调用工具时自动启动",
  failed: "启动失败：常见原因 —— 路径带 \\\\?\\ 前缀、npx 首次拉包慢、网络/代理不可达",
};

function statusText(status: string): string {
  switch (status) {
    case "connected":
      return "已连接";
    case "keep-alive":
      return "保活";
    case "lazy":
    case "not-connected":
      return "惰性";
    case "connecting":
      return "连接中";
    case "failed":
      return "失败";
    case "needs-auth":
      return "需认证";
    case "disabled":
      return "已禁用";
    default:
      return status;
  }
}

export function McpPanel({ mcp, onCommand, onClose, onToast }: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<"form" | "json">("form");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [busy, setBusy] = useState(false);

  const parseJsonImport = (): Record<string, unknown> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`JSON 解析失败: ${(e as Error).message}`);
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON 必须是对象");
    }
    const obj = parsed as Record<string, unknown>;
    // 支持 { "mcpServers": { name: config } } 包装形式
    if (obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers)) {
      return obj.mcpServers as Record<string, unknown>;
    }
    // 也支持单个 server 配置：{ "name": { "command": ... } }
    return obj;
  };

  const addJson = async () => {
    setBusy(true);
    setJsonError("");
    try {
      const servers = parseJsonImport();
      const names = Object.keys(servers);
      if (names.length === 0) {
        setJsonError("没有可导入的服务");
        return;
      }
      for (const [n, config] of Object.entries(servers)) {
        if (!config || typeof config !== "object") {
          setJsonError(`服务 ${n} 的配置无效（应为对象）`);
          return;
        }
      }
      await addMcpServersBatch(servers);
      onToast("ok", `已导入 ${names.length} 个 MCP 服务：${names.join(", ")}`);
      setJsonText("");
      setShowAdd(false);
    } catch (e) {
      setJsonError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addServer = async (n: string, config: Record<string, unknown>) => {
    setBusy(true);
    try {
      await addMcpServer(n, config);
      onToast("ok", `已添加 MCP 服务 ${n}，配置已写入 .mcp.json`);
      setShowAdd(false);
      setName("");
      setCommand("npx");
      setArgs("");
    } catch (e) {
      onToast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeServer = async (n: string) => {
    if (!window.confirm(`确定移除 MCP 服务 ${n} 吗？`)) return;
    setBusy(true);
    try {
      await removeMcpServer(n);
      onToast("ok", `已移除 ${n}`);
    } catch (e) {
      onToast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const servers = mcp?.servers ?? [];

  return (
    <>
      <div className="panel-tabs">
        <div className="panel-tab active">MCP 服务</div>
        <div className="panel-tab" onClick={onClose}>
          关闭 ✕
        </div>
      </div>
      <div className="panel-body">
        <div className="panel-title">已配置服务</div>
        <div className="panel-sub">
          自动读取 .mcp.json、~/.config/mcp/mcp.json 等标准配置；惰性连接，首次调用工具时才启动。
        </div>

        {servers.length === 0 && (
          <div style={{ fontSize: "12px", color: "var(--text-3)" }}>暂无服务。从下方「快速添加」或「市场」添加。</div>
        )}

        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <button
            className="mini-btn"
            disabled={busy}
            onClick={() => onCommand("/reload")}
            title="配置变更（如手工改 .mcp.json）后需要重新加载才能发现"
          >
            ↻ 重新加载配置
          </button>
          <button className="mini-btn" disabled={busy} onClick={() => onCommand("/mcp reconnect")}>
            全部重连
          </button>
        </div>

        {servers.map((s) => (
          <div key={s.name} className="mcp-server">
            <div className="row1">
              <span className={`dot ${s.status === "connected" || s.status === "keep-alive" ? "on" : s.status === "failed" ? "err" : "off"}`} />
              <span className="sname">{s.name}</span>
              <span className="sstatus">
                {statusText(s.status)}
                {s.failedAgoSeconds != null ? ` (${s.failedAgoSeconds}s前)` : ""}
              </span>
              <span className="sact">
                <button
                  className="mini-btn"
                  disabled={busy}
                  onClick={() => onCommand(`/mcp reconnect ${s.name}`)}
                  title="连接/重连"
                >
                  重连
                </button>
                <button className="mini-btn danger" disabled={busy} onClick={() => void removeServer(s.name)}>
                  移除
                </button>
              </span>
            </div>
            <div className="row2">
              {s.toolCount} 个工具{s.resourceCount != null ? ` · ${s.resourceCount} 个资源` : ""}
              {s.disabled ? " · 已禁用" : ""}
              {FAILED_HINTS[s.status] ? ` · ${FAILED_HINTS[s.status]}` : ""}
            </div>
          </div>
        ))}

        {showAdd ? (
          <div className="add-form">
            <div style={{ display: "flex", gap: "6px" }}>
              <button className={`mini-btn ${addMode === "form" ? "primary" : ""}`} onClick={() => setAddMode("form")}>
                表单
              </button>
              <button className={`mini-btn ${addMode === "json" ? "primary" : ""}`} onClick={() => setAddMode("json")}>
                JSON
              </button>
            </div>
            {addMode === "form" ? (
              <>
                <input placeholder="服务名称（如 github）" value={name} onChange={(e) => setName(e.target.value)} />
                <div className="form-row">
                  <input className="grow" placeholder="命令（npx / uvx / node…）" value={command} onChange={(e) => setCommand(e.target.value)} />
                </div>
                <textarea
                  placeholder={"参数，每行一个（如 -y @modelcontextprotocol/server-github）"}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
                <div className="form-row">
                  <button
                    className="btn primary grow"
                    disabled={busy || !name.trim()}
                    onClick={() =>
                      void addServer(name.trim(), {
                        command: command.trim() || "npx",
                        args: args.split("\n").map((a) => a.trim()).filter(Boolean),
                      })
                    }
                  >
                    添加
                  </button>
                  <button className="btn" onClick={() => setShowAdd(false)}>
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <textarea
                  style={{ minHeight: "120px", fontFamily: "var(--mono)", fontSize: "11px" }}
                  placeholder={`粘贴 JSON，支持两种格式：\n\n// 单个/多个服务\n{\n  "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n}\n\n// 或带 mcpServers 包装\n{\n  "mcpServers": { "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] } }\n}`}
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value);
                    setJsonError("");
                  }}
                />
                {jsonError && <div style={{ color: "var(--red)", fontSize: "12px" }}>⚠ {jsonError}</div>}
                <div className="form-row">
                  <button
                    className="btn primary grow"
                    disabled={busy || !jsonText.trim()}
                    onClick={() => void addJson()}
                  >
                    导入
                  </button>
                  <button className="btn" onClick={() => setShowAdd(false)}>
                    取消
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <button className="btn" onClick={() => setShowAdd(true)}>
            ＋ 手动添加服务
          </button>
        )}

        <button className="btn" onClick={() => void getMcpConfig().then(() => onToast("info", "MCP 配置读取成功"))}>
          刷新配置
        </button>
      </div>
    </>
  );
}
