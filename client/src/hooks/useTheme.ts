import { useCallback, useEffect, useState } from "react";

/** Theme resolution: URL ?theme= > localStorage > system preference. */
export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const urlTheme = new URLSearchParams(location.search).get("theme");
      if (urlTheme === "light" || urlTheme === "dark") return urlTheme;
      const saved = localStorage.getItem("pi-studio-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* ignore */
    }
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("pi-studio-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme };
}
