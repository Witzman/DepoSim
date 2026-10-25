import type { KeyboardEvent } from "react";

/**
 * Arrow keys, Home and End move between the tabs of a tablist and select the one reached, as the ARIA pattern for tabs asks.
 * The selected tab alone is in the tab order (`tabIndex`), the others are reached by arrow keys.
 */
export function tabKeys(e: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0 || tabs.length === 0) return;
  const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}
