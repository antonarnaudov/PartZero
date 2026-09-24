import { BudgetExceededError, GatewayError } from "./errors.js";
import type { Billing } from "./types.js";

export interface LedgerEntry {
  taskId: string;
  model: string;
  responseId: string;
  costUsd: number;
  projectedUsd: number;
  at: string;
  /** Who paid (ADR 0014). Subscription amounts are notional (API list price). */
  billing?: Billing;
  /** `call`: a gateway call; `external`: charged after the fact (CLI runtime phases). */
  source?: "call" | "external";
}

export interface Reservation {
  readonly id: number;
  readonly projectedUsd: number;
}

/**
 * Per-task USD budget. Before each call the gateway reserves the call's projected worst-case cost; if spent + in-flight
 * reservations + projection would exceed the cap, the call is refused with {@link BudgetExceededError} and never
 * issued. When the call finishes, the reservation is replaced by the actual cost (or released if the call failed).
 */
export class BudgetGuard {
  readonly taskId: string;
  readonly capUsd: number;
  readonly ledger: LedgerEntry[] = [];
  #spentUsd = 0;
  #reserved = new Map<number, number>();
  #nextId = 1;

  constructor(taskId: string, capUsd: number) {
    if (!(capUsd >= 0) || !Number.isFinite(capUsd)) throw new GatewayError("config", `Budget for task ${taskId} must be a finite, non-negative USD amount`);
    this.taskId = taskId;
    this.capUsd = capUsd;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get reservedUsd(): number {
    let sum = 0;
    for (const v of this.#reserved.values()) sum += v;
    return sum;
  }

  get remainingUsd(): number {
    return Math.max(0, this.capUsd - this.#spentUsd - this.reservedUsd);
  }

  /** Throws BudgetExceededError if the projected call does not fit; otherwise holds its projected cost. */
  reserve(projectedUsd: number, model: string): Reservation {
    const spent = this.#spentUsd;
    const reserved = this.reservedUsd;
    // Tiny epsilon so floating-point sums of exactly-fitting calls are not refused.
    if (spent + reserved + projectedUsd > this.capUsd + 1e-12) {
      throw new BudgetExceededError({ taskId: this.taskId, capUsd: this.capUsd, spentUsd: spent, reservedUsd: reserved, projectedUsd, model });
    }
    const id = this.#nextId++;
    this.#reserved.set(id, projectedUsd);
    return { id, projectedUsd };
  }

  /** Replace a reservation with the call's actual cost. */
  settle(reservation: Reservation, entry: Omit<LedgerEntry, "taskId" | "projectedUsd" | "at">): void {
    this.#reserved.delete(reservation.id);
    this.#spentUsd += entry.costUsd;
    this.ledger.push({ ...entry, taskId: this.taskId, projectedUsd: reservation.projectedUsd, at: new Date().toISOString() });
  }

  /**
   * Record an already-incurred cost without a reservation (CLI runtime phases, where the CLI owns the model loop and
   * the cost is only known afterwards). Never throws, even when it pushes the task over its cap: the caller's budget
   * gate decides what to do next. Non-finite or negative amounts are recorded as 0.
   */
  charge(entry: { model: string; responseId: string; costUsd: number; billing?: Billing }): void {
    const costUsd = Number.isFinite(entry.costUsd) && entry.costUsd > 0 ? entry.costUsd : 0;
    this.#spentUsd += costUsd;
    const row: LedgerEntry = { taskId: this.taskId, model: entry.model, responseId: entry.responseId, costUsd, projectedUsd: 0, at: new Date().toISOString(), source: "external" };
    if (entry.billing !== undefined) row.billing = entry.billing;
    this.ledger.push(row);
  }

  /** Drop a reservation for a call that failed before producing billable output. */
  release(reservation: Reservation): void {
    this.#reserved.delete(reservation.id);
  }
}
