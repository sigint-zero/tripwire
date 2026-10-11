import { useCallback, useSyncExternalStore } from "react";

/** How a list is laid out: one full-width row each, or a grid of cards. */
export type ListView = "rows" | "cards";

const KEY = "tripwire:rules-view";
const listeners = new Set<() => void>();

/** The saved choice; rows when none, or when the browser keeps no site data. */
export function readView(storage: Pick<Storage, "getItem"> | null): ListView {
  try {
    return storage?.getItem(KEY) === "cards" ? "cards" : "rows";
  } catch {
    return "rows";
  }
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab's choice applies here too.
  const other = (e: StorageEvent) => e.key === KEY && listener();
  window.addEventListener("storage", other);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", other);
  };
}

/**
 * The rule lists' Rows or Cards choice, kept in the browser, so it holds on
 * the Rules page and every contract's page, and after a reload.
 */
export function useRulesView(): [ListView, (view: ListView) => void] {
  const view = useSyncExternalStore(subscribe, () => readView(storage()));
  const choose = useCallback((next: ListView) => {
    try {
      storage()?.setItem(KEY, next);
    } catch {
      // Not kept; it still applies until the page is left.
    }
    for (const listener of listeners) listener();
  }, []);
  return [view, choose];
}
