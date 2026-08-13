import { useCallback, useState } from "react";

type ToastFn = (level: "info" | "warn" | "error" | "ok", message: string) => void;

/**
 * Shared busy state + guarded async runner for right-side panels.
 * `run` sets `busy`, executes `fn`, and reports failures as an error
 * toast when a toast function is supplied (finally clears `busy`).
 */
export function usePanel(toast?: ToastFn) {
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        toast?.("error", (e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [toast]
  );

  return { busy, setBusy, run };
}
