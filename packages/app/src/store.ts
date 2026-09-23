/**
 * A minimal observable store: immutable snapshots + listeners. React reads it through
 * `useSyncExternalStore` (see `ui/hooks.ts`); non-React code (commands, tests) uses it directly.
 */
export type Listener = () => void;

export class Store<T extends object> {
  private state: T;
  private readonly listeners = new Set<Listener>();

  constructor(initial: T) {
    this.state = initial;
  }

  readonly getState = (): T => this.state;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  protected setState(patch: Partial<T> | ((s: T) => Partial<T>)): void {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    let changed = false;
    for (const k of Object.keys(p) as (keyof T)[]) {
      if (!Object.is(this.state[k], p[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  }

  /** Resolve once `predicate(state)` holds (checked now and after every change). */
  waitFor(predicate: (s: T) => boolean, timeoutMs = 60_000): Promise<T> {
    if (predicate(this.state)) return Promise.resolve(this.state);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out after ${timeoutMs} ms waiting for store state`));
      }, timeoutMs);
      const unsubscribe = this.subscribe(() => {
        if (!predicate(this.state)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(this.state);
      });
    });
  }
}
