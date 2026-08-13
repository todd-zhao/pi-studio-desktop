import { useCallback, useRef, useState } from "react";
import type { Toast } from "../types-app";

/** Toast queue with auto-dismiss (6s) and a max of 5 visible toasts. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((level: Toast["level"], message: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-4), { id, level, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  return { toasts, toast };
}
