import { useCallback, useEffect, useRef, useState } from "react";
import { storedPaneWidth } from "../types-app";

/** Sidebar / right-panel layout state plus drag-to-resize logic. */
export function useLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => storedPaneWidth("pi-studio-sidebar-width", 264, 220, 420));
  const [rightPanelWidth, setRightPanelWidth] = useState(() => storedPaneWidth("pi-studio-right-panel-width", 380, 280, 600));
  const resizeRef = useRef<{ target: "sidebar" | "right"; startX: number; startWidth: number } | null>(null);

  const startResize = useCallback((target: "sidebar" | "right", event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = {
      target,
      startX: event.clientX,
      startWidth: target === "sidebar" ? sidebarWidth : rightPanelWidth,
    };
    document.body.classList.add("is-resizing-columns");
  }, [rightPanelWidth, sidebarWidth]);

  const stopResize = useCallback(() => {
    resizeRef.current = null;
    document.body.classList.remove("is-resizing-columns");
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const delta = event.clientX - resize.startX;
      if (resize.target === "sidebar") {
        setSidebarWidth(Math.min(420, Math.max(220, resize.startWidth + delta)));
      } else {
        setRightPanelWidth(Math.min(600, Math.max(280, resize.startWidth - delta)));
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
  }, [stopResize]);

  useEffect(() => {
    try {
      localStorage.setItem("pi-studio-sidebar-width", String(sidebarWidth));
      localStorage.setItem("pi-studio-right-panel-width", String(rightPanelWidth));
    } catch {
      /* ignore unavailable storage */
    }
  }, [rightPanelWidth, sidebarWidth]);

  return { sidebarOpen, setSidebarOpen, sidebarWidth, rightPanelWidth, startResize, stopResize };
}
