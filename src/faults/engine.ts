import type { Clock } from "../core/clock.js";
import type { FaultEvent, FaultSpec, FaultType, Occurrence, ProviderTool, Target, Where } from "./types.js";

type FaultOf<T extends FaultType> = Extract<FaultSpec, { type: T }> & { id: string };

export function matchesWhere(where: Where | undefined, target: Target): boolean {
  if (!where) return true;
  if (where.hotel_id !== undefined && where.hotel_id !== target.hotel_id) return false;
  if (where.room_id !== undefined && where.room_id !== target.room_id) return false;
  if (where.plan_id !== undefined && where.plan_id !== target.plan_id) return false;
  return true;
}

function occurrenceFires(occurrence: Occurrence | undefined, count: number): boolean {
  const occ = occurrence ?? "first";
  if (occ === "always") return true;
  if (occ === "first") return count === 1;
  return count === occ;
}

/**
 * Decides which faults fire. It holds no catalog knowledge: the provider asks
 * "does a fault of type X fire for this tool and target?" at well-defined points.
 *
 * Counting rule: a fault's counter increments once per call that reaches its check
 * point and matches its `where`. Calls rejected earlier (e.g. by a rate limit) never
 * reach later check points, so they are not counted. This keeps runs reproducible.
 */
export class FaultEngine {
  readonly faults: ReadonlyArray<FaultSpec & { id: string }>;
  readonly events: FaultEvent[] = [];
  private readonly counters = new Map<string, number>();
  /** Rate limit windows: fault id -> epoch ms when the window ends. */
  private readonly windows = new Map<string, number>();

  constructor(
    specs: readonly FaultSpec[],
    private readonly clock: Clock,
  ) {
    const seen = new Set<string>();
    this.faults = specs.map((f, i) => {
      const id = f.id ?? `${f.type}#${i}`;
      if (seen.has(id)) throw new Error(`FaultEngine: duplicate fault id "${id}"`);
      seen.add(id);
      return { ...f, id };
    });
  }

  private ofType<T extends FaultType>(type: T): Array<FaultOf<T>> {
    return this.faults.filter((f) => f.type === type) as Array<FaultOf<T>>;
  }

  private bump(id: string): number {
    const n = (this.counters.get(id) ?? 0) + 1;
    this.counters.set(id, n);
    return n;
  }

  private record(fault: FaultSpec & { id: string }, tool: ProviderTool, detail?: Record<string, unknown>): void {
    this.events.push({ fault_id: fault.id, type: fault.type, tool, at: this.clock.nowIso(), ...(detail ? { detail } : {}) });
  }

  /**
   * Occurrence-based check: returns the first fault of `type` that fires for this call.
   * `extra` filters faults before counting (e.g. ErrorFault.on, SoldOutFault.stage).
   */
  fire<T extends FaultType>(
    type: T,
    tool: ProviderTool,
    target: Target,
    extra?: (f: FaultOf<T>) => boolean,
    detail?: (f: FaultOf<T>) => Record<string, unknown>,
  ): FaultOf<T> | undefined {
    let fired: FaultOf<T> | undefined;
    for (const f of this.ofType(type)) {
      if (extra && !extra(f)) continue;
      const where = (f as { where?: Where }).where;
      if (!matchesWhere(where, target)) continue;
      const n = this.bump(f.id);
      const occurrence = (f as { occurrence?: Occurrence }).occurrence;
      if (!fired && occurrenceFires(occurrence, n)) fired = f;
    }
    if (fired) this.record(fired, tool, detail?.(fired));
    return fired;
  }

  /** Static (always-on) faults that alter what is displayed, e.g. labels and tax display. */
  active<T extends "mislabeled_refundable" | "taxes_excluded">(type: T, target: Target): FaultOf<T> | undefined {
    return this.ofType(type).find((f) => matchesWhere((f as { where?: Where }).where, target));
  }

  has(type: FaultType): boolean {
    return this.faults.some((f) => f.type === type);
  }

  /**
   * Rate limiting. Returns the remaining wait in seconds if the call must be rejected.
   * Calls made during an open window are rejected (and logged) without being counted.
   */
  rateLimit(tool: ProviderTool): number | undefined {
    const now = this.clock.now();
    for (const f of this.ofType("rate_limit")) {
      if (f.on !== "any" && f.on !== tool) continue;
      const until = this.windows.get(f.id);
      if (until !== undefined && now < until) {
        const remaining = Math.ceil((until - now) / 1000);
        this.record(f, tool, { retry_after_s: remaining, during_window: true });
        return remaining;
      }
    }
    for (const f of this.ofType("rate_limit")) {
      if (f.on !== "any" && f.on !== tool) continue;
      const n = this.bump(f.id);
      if (occurrenceFires(f.occurrence, n)) {
        this.windows.set(f.id, now + f.retry_after_s * 1000);
        this.record(f, tool, { retry_after_s: f.retry_after_s, during_window: false });
        return f.retry_after_s;
      }
    }
    return undefined;
  }
}
