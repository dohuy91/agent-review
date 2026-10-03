import { useEffect, useState } from "react";
import type { ThemePreference } from "./preferences.js";

function systemQuery() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

/** Resolve the persisted preference without saving the current OS color scheme. */
export function useTheme(theme: ThemePreference): boolean {
  const [systemDark, setSystemDark] = useState(
    () => systemQuery()?.matches ?? false,
  );
  useEffect(() => {
    if (theme !== "system") return;
    const query = systemQuery();
    const update = () => setSystemDark(query?.matches ?? false);
    update();
    if (query?.addEventListener) {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    if (query?.addListener) {
      query.addListener(update);
      return () => query.removeListener(update);
    }
  }, [theme]);
  return theme === "system" ? systemDark : theme === "dark";
}
