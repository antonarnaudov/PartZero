import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { AppCommandRegistry, AppInvocation } from "../commands/commands";
import type { CommandSource } from "../commands/registry";
import type { AppServices } from "../services";
import type { Store } from "../store";

export interface AppContextValue {
  services: AppServices;
  commands: AppCommandRegistry;
  /** Execute a command from the UI (failures surface as toasts, see `bootstrap.ts`). */
  run: (cmd: AppInvocation, source?: CommandSource) => void;
  isMac: boolean;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error("AppContext missing");
  return v;
}

/** Subscribe to a slice of a store. The selector must return a stable (memoizable) value. */
export function useStore<T extends object, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

/** Subscribe to a derived value computed from a store snapshot (recomputed when the snapshot changes). */
export function useDerived<T extends object, S>(store: Store<T>, derive: (s: T) => S): S {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  // `derive` is expected to be pure: recompute only when the snapshot changes.
  return useMemo(() => derive(snapshot), [snapshot]);
}
