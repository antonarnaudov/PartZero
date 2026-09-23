/**
 * Undo/redo of source-level transactions. Consecutive edits with the same `coalesceKey` inside
 * `coalesceMs` merge into one transaction (typing a word is one undo step). A whole agent turn
 * will be one transaction too (see ARCHITECTURE §7: "the whole task is one undo step").
 */
import { applyEdit, diffText, invertEdit, type TextEdit } from "./text-edit";

export type TransactionOrigin = "user" | "command" | "agent" | "system";

export interface Transaction {
  label: string;
  origin: TransactionOrigin;
  edit: TextEdit;
  /** When set, a following edit with the same key within the coalescing window merges into this one. */
  coalesceKey?: string;
  /** ms timestamp of the last merged edit. */
  time: number;
}

export interface HistoryOptions {
  limit?: number;
  coalesceMs?: number;
}

export class History {
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];
  private readonly limit: number;
  private readonly coalesceMs: number;
  /** Set by {@link seal}: the next edit never merges into the current top. */
  private sealed = false;

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? 500;
    this.coalesceMs = options.coalesceMs ?? 1000;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  get size(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  /**
   * Record `before → after`. Returns the stored transaction (possibly merged). `before` must be the
   * current document text (the text the top transaction produced).
   */
  record(
    before: string,
    after: string,
    meta: { label: string; origin: TransactionOrigin; coalesceKey?: string | undefined; time: number },
  ): Transaction | null {
    if (before === after) return null;
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      !this.sealed &&
      top &&
      meta.coalesceKey !== undefined &&
      top.coalesceKey === meta.coalesceKey &&
      meta.time - top.time <= this.coalesceMs
    ) {
      const original = applyEdit(before, invertEdit(top.edit));
      if (original === after) {
        // The merged edits cancel out: drop the transaction entirely.
        this.undoStack.pop();
        return null;
      }
      const merged: Transaction = { ...top, edit: diffText(original, after), time: meta.time };
      this.undoStack[this.undoStack.length - 1] = merged;
      return merged;
    }
    this.sealed = false;
    const tx: Transaction = { label: meta.label, origin: meta.origin, edit: diffText(before, after), time: meta.time };
    if (meta.coalesceKey !== undefined) tx.coalesceKey = meta.coalesceKey;
    this.undoStack.push(tx);
    if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
    return tx;
  }

  /** Close the current transaction: the next edit starts a new one even if it could coalesce. */
  seal(): void {
    this.sealed = true;
  }

  /** Undo the top transaction on `text`; returns the new text, or null when there is nothing to undo. */
  undo(text: string): { text: string; tx: Transaction } | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    this.redoStack.push(tx);
    this.sealed = true;
    return { text: applyEdit(text, invertEdit(tx.edit)), tx };
  }

  redo(text: string): { text: string; tx: Transaction } | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    this.undoStack.push(tx);
    this.sealed = true;
    return { text: applyEdit(text, tx.edit), tx };
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.sealed = false;
  }
}
