import { createRoot, type Root } from "react-dom/client";

/**
 * In-app replacement for window.confirm().
 *
 * Electron's native JS dialogs (alert/confirm/prompt) have long-standing
 * Windows focus bugs: after the dialog closes the BrowserWindow can fail to
 * regain keyboard/mouse input, leaving the app looking frozen. This component
 * renders a plain React modal instead, so no native dialog is ever involved.
 */
export interface ConfirmOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "modal-backdrop confirm-overlay";
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    const cleanup = (ok: boolean) => {
      root.unmount();
      host.remove();
      resolve(ok);
    };
    root.render(
      <div
        className="confirm-surface"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.target === e.currentTarget && cleanup(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") cleanup(false);
          if (e.key === "Enter") cleanup(true);
        }}
      >
        <div className="modal" style={{ width: "min(420px, 90vw)" }}>
          <div className="modal-head">
            <span className="nm">{options.title ?? "确认操作"}</span>
          </div>
          <div className="modal-body" style={{ whiteSpace: "pre-wrap" }}>
            {message}
          </div>
          <div className="confirm-actions">
            <button className="mini-btn" autoFocus onClick={() => cleanup(false)}>
              {options.cancelText ?? "取消"}
            </button>
            <button
              className={`mini-btn ${options.danger ? "danger" : ""}`}
              onClick={() => cleanup(true)}
            >
              {options.confirmText ?? "确定"}
            </button>
          </div>
        </div>
      </div>
    );
  });
}
