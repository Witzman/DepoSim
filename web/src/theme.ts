import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "deposim-theme";

const systemTheme = (): Theme =>
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null; // private window or blocked storage: the page works without it
  }
}

/** The theme in force, a way to flip it, and a change counter for things drawn outside CSS. */
export function useTheme() {
  const [explicit, setExplicit] = useState<Theme | null>(stored);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    if (explicit) document.documentElement.dataset.theme = explicit;
    else delete document.documentElement.dataset.theme;
  }, [explicit]);

  const effective = explicit ?? system;
  const toggle = useCallback(() => {
    const next: Theme = effective === "dark" ? "light" : "dark";
    setExplicit(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // the choice then lasts only until the page is closed
    }
  }, [effective]);

  return { theme: effective, toggle };
}
