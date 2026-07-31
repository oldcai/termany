import type { Tier } from "@termany/core";

/**
 * The audit ring: every control call that was attempted, whatever became of it.
 *
 * This is a security surface, not a debug convenience. "An agent typed something
 * into my shell and I don't know what" has to be answerable after the fact, so
 * entries are written for denials and consent refusals too — a call that was
 * blocked is precisely the one worth reading about.
 *
 * Bounded and drop-oldest, with a monotonic cursor so a reader can tell "nothing
 * happened" apart from "I fell behind and missed some".
 */

export type Outcome = "allowed" | "asked-allowed" | "asked-denied" | "denied" | "error";

export interface AuditEntry {
  /** Monotonic, gap-free, and never reused within a process lifetime. */
  seq: number;
  at: number;
  method: string;
  tier: Tier;
  outcome: Outcome;
  callerPaneId: string;
  callerPath: string;
  /** Absent when the call failed before a pane was resolved. */
  targetPaneId?: string;
  targetPath?: string;
  /** Error code for a failed call, or a one-line summary of what was done. */
  detail?: string;
}

const CAPACITY = 500;

export class AuditRing {
  private entries: AuditEntry[] = [];
  private nextSeq = 1;

  constructor(
    private capacity = CAPACITY,
    private now: () => number = Date.now
  ) {}

  record(entry: Omit<AuditEntry, "seq" | "at">): AuditEntry {
    const full: AuditEntry = { ...entry, seq: this.nextSeq++, at: this.now() };
    this.entries.push(full);
    while (this.entries.length > this.capacity) this.entries.shift();
    return full;
  }

  /**
   * Entries after `sinceSeq`, oldest first, plus how many were lost before them.
   *
   * `dropped` is derived from what the ring still holds rather than counted into
   * a shared tally that a read consumes: this ring is served over an endpoint
   * anyone on loopback can poll, and one stray poll must not eat the app's own
   * evidence that it has a gap. A reader that keeps up sees 0; a reader that
   * sees non-zero knows exactly how many entries it will never get.
   *
   * Truncation keeps the OLDEST entries past `sinceSeq`, so `cursor` is the last
   * entry actually returned — a reader that follows the cursor never steps over
   * entries it was not given. Bounds are clamped here because the HTTP caller's
   * query string reaches this directly.
   */
  read(sinceSeq = 0, limit = 200): { entries: AuditEntry[]; dropped: number; cursor: number } {
    const from = Number.isFinite(sinceSeq) ? Math.max(0, Math.trunc(sinceSeq)) : 0;
    const take = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), this.capacity))
      : Math.min(200, this.capacity);
    // Every seq below the oldest entry we still hold is gone for good.
    const oldest = this.entries.length ? this.entries[0].seq : this.nextSeq;
    const entries = this.entries.filter((e) => e.seq > from).slice(0, take);
    return {
      entries,
      dropped: Math.max(0, oldest - 1 - from),
      cursor: entries.length ? entries[entries.length - 1].seq : from,
    };
  }

  get size(): number {
    return this.entries.length;
  }
}
