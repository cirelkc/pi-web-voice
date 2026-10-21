import { useSyncExternalStore } from "react";

/**
 * How the session sidebar orders its project groups: "recent" puts the
 * project used last on top (each band by its newest session), "saved" keeps
 * the order the user dragged into place (`projectOrder` in the server's
 * pi-web-session-state.json). A per-browser view choice, like the files
 * placement: one server can serve a phone and a desktop.
 */
export type ProjectOrderMode = "recent" | "saved";

export const PROJECT_ORDER_STORAGE_KEY = "pi-web:sidebar-project-order";
export const PROJECT_ORDER_DEFAULT: ProjectOrderMode = "recent";

export function parseProjectOrder(raw: string | null): ProjectOrderMode {
  return raw === "saved" ? "saved" : PROJECT_ORDER_DEFAULT;
}

function readStoredOrder(): ProjectOrderMode {
  try {
    return parseProjectOrder(window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY));
  } catch {
    return PROJECT_ORDER_DEFAULT;
  }
}

let order: ProjectOrderMode | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): ProjectOrderMode {
  if (order === null) order = readStoredOrder();
  return order;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

// Another tab chose; `key` is null when that tab cleared its storage.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== PROJECT_ORDER_STORAGE_KEY) return;
  const next = readStoredOrder();
  if (next === order) return;
  order = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    // Nobody listened for another tab's choice meanwhile.
    order = readStoredOrder();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setProjectOrder(next: ProjectOrderMode): void {
  if (next === getSnapshot()) return;
  order = next;
  try {
    window.localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, next);
  } catch {
    // Applies in memory even if the browser cannot save it.
  }
  notify();
}

export function useProjectOrder(): ProjectOrderMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => PROJECT_ORDER_DEFAULT);
}
