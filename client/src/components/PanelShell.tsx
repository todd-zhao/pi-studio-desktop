import type { ReactNode } from "react";

interface PanelShellProps {
  title: string;
  subtitle?: string;
  hint?: string;
  onClose: () => void;
  actions?: ReactNode;
  closeLabel?: string;
  variant?: "tabs" | "tabs-full" | "head" | "team" | "wechat";
  className?: string;
  children?: ReactNode;
}

/**
 * Shared outer shell for the right-side panels: renders the header row
 * (title, optional subtitle/actions, close button) and optional hint.
 *
 * variant:
 *  - "tabs":      panel-body with an inline panel-tabs header (Agents / Models / Projects)
 *  - "tabs-full": full-width dual tabs (active title + "关闭 ×") then panel-body (Skills / Mcp)
 *  - "head":      right-panel-inner + panel-head (h3) + optional panel-hint (Archived / Schedules)
 *  - "team":      team-panel-header row (uses "←" back arrow when closeLabel is "返回")
 *  - "wechat":    wechat-head row; the parent keeps the wechat-panel / wechat-body wrappers
 */
export function PanelShell({
  title,
  subtitle,
  hint,
  onClose,
  actions,
  closeLabel = "关闭",
  variant = "tabs",
  className,
  children,
}: PanelShellProps) {
  if (variant === "tabs") {
    return (
      <div className="panel-body" style={{ overflowY: "auto", flex: 1 }}>
        <div className="panel-tabs" style={{ margin: "-12px -12px 10px", padding: "0 12px", borderBottom: "1px solid var(--border)" }}>
          <span className="panel-title" style={{ lineHeight: "36px" }}>{title}</span>
          {subtitle != null && (
            <span className="panel-sub" style={{ marginLeft: "8px", lineHeight: "36px" }}>{subtitle}</span>
          )}
          {actions != null && (
            <span style={{ marginLeft: "auto", marginTop: "8px", display: "inline-flex", alignItems: "center", gap: "8px" }}>{actions}</span>
          )}
          <button
            className="icon-btn"
            title={closeLabel}
            style={actions != null ? undefined : { marginLeft: "auto", marginTop: "8px" }}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    );
  }

  if (variant === "tabs-full") {
    return (
      <>
        <div className="panel-tabs">
          <div className="panel-tab active">{title}</div>
          <div className="panel-tab" onClick={onClose}>{closeLabel} ×</div>
        </div>
        <div className="panel-body">{children}</div>
      </>
    );
  }

  if (variant === "head") {
    return (
      <div className={"right-panel-inner" + (className ? " " + className : "")}>
        <div className="panel-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        {hint != null && <p className="panel-hint">{hint}</p>}
        {children}
      </div>
    );
  }

  if (variant === "team") {
    return (
      <div className="team-panel-header">
        <span className="panel-title">{title}</span>
        <button className="icon-btn" title={closeLabel} onClick={onClose}>{closeLabel === "返回" ? "←" : "×"}</button>
      </div>
    );
  }

  return (
    <div className="wechat-head">
      <div>
        <div className="panel-title">{title}</div>
        {subtitle != null && <div className="panel-sub">{subtitle}</div>}
      </div>
      <button className="icon-btn" title={closeLabel} onClick={onClose}>×</button>
    </div>
  );
}
