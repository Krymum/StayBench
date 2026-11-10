/**
 * Injectable clock. The simulator never reads wall-clock time: time only moves when
 * the session advances it (fixed tick per tool call, or an explicit `wait`).
 */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
  nowIso(): string;
}

export class VirtualClock implements Clock {
  private ms: number;

  constructor(start: string | number) {
    const ms = typeof start === "number" ? start : Date.parse(start);
    if (Number.isNaN(ms)) throw new Error(`VirtualClock: invalid start time "${start}"`);
    this.ms = ms;
  }

  now(): number {
    return this.ms;
  }

  nowIso(): string {
    return new Date(this.ms).toISOString();
  }

  advance(seconds: number): void {
    if (!(seconds >= 0)) throw new Error(`VirtualClock: cannot advance by ${seconds}s`);
    this.ms += Math.round(seconds * 1000);
  }
}
