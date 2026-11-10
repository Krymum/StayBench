import { VirtualClock } from "../core/clock.js";
import { HotelProvider } from "../simulator/provider.js";
import { generateWorld } from "../simulator/world-gen.js";
import type { Result } from "../simulator/types.js";
import { TraceWriter } from "../trace/io.js";
import {
  TRACE_FORMAT_VERSION,
  type RunConfig,
  type ToolOutcome,
  type TraceCall,
  type TraceEnd,
  type TraceHeader,
} from "../trace/types.js";
import { Traveler, type TravelerContext } from "../traveler/traveler.js";
import { STAYBENCH_VERSION } from "../version.js";
import { TOOL_SCHEMAS, type FinalReport, type ToolName } from "./tools.js";

export interface SessionOptions {
  /** Write the trace to this JSONL file as the run progresses. */
  tracePath?: string;
  /** Free-form agent info stored in the trace header. */
  agent?: Record<string, unknown>;
}

function toOutcome(r: Result<unknown>): ToolOutcome {
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: { ...r.error } };
}

/**
 * One run of one scenario: owns the clock, the simulated provider, the traveler and the
 * trace. Every tool call (MCP, scripted agent or replay) goes through `call`, which makes
 * the trace the complete and replayable record of the run.
 */
export class RunSession {
  readonly clock: VirtualClock;
  readonly provider: HotelProvider;
  readonly traveler: Traveler;
  readonly header: TraceHeader;
  readonly calls: TraceCall[] = [];
  private endLine: TraceEnd | null = null;
  private readonly writer?: TraceWriter;
  private latestPrebook: TravelerContext["latestPrebook"];

  constructor(
    readonly run: RunConfig,
    opts: SessionOptions = {},
  ) {
    this.clock = new VirtualClock(run.start_time);
    this.provider = new HotelProvider({ world: generateWorld(run.world), faults: run.faults, clock: this.clock });
    this.traveler = new Traveler(run.traveler);
    this.header = {
      type: "header",
      format: TRACE_FORMAT_VERSION,
      staybench_version: STAYBENCH_VERSION,
      run,
      ...(opts.agent ? { agent: opts.agent } : {}),
    };
    if (opts.tracePath) {
      this.writer = new TraceWriter(opts.tracePath);
      this.writer.write(this.header);
    }
  }

  get finished(): boolean {
    return this.endLine !== null;
  }

  get report(): FinalReport | null {
    return (this.endLine?.report as FinalReport | null) ?? null;
  }

  get end(): TraceEnd | null {
    return this.endLine;
  }

  /** Text to hand to the agent as the traveler's request. */
  get request(): string {
    return this.traveler.request;
  }

  call(tool: string, rawArgs: unknown): ToolOutcome {
    if (this.finished) {
      return { ok: false, error: { code: "RUN_FINISHED", message: "The final report was submitted; the run is over." } };
    }
    this.clock.advance(this.run.tick_s);
    const faultCount = this.provider.faults.events.length;
    let outcome: ToolOutcome;
    let meta: Record<string, unknown> = {};

    const schema = (TOOL_SCHEMAS as Record<string, (typeof TOOL_SCHEMAS)[ToolName]>)[tool];
    if (!schema) {
      outcome = { ok: false, error: { code: "UNKNOWN_TOOL", message: `Unknown tool "${tool}".` } };
    } else {
      const parsed = schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        outcome = { ok: false, error: { code: "INVALID_ARGUMENTS", message: msg } };
      } else {
        ({ outcome, meta } = this.dispatch(tool as ToolName, parsed.data));
      }
    }

    const fired = this.provider.faults.events.slice(faultCount);
    if (fired.length > 0) meta.faults = fired.map((e) => ({ fault_id: e.fault_id, type: e.type, ...(e.detail ? { detail: e.detail } : {}) }));

    const line: TraceCall = {
      type: "call",
      seq: this.calls.length + 1,
      t: this.clock.nowIso(),
      tool,
      args: rawArgs ?? {},
      result: outcome,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
    this.calls.push(line);
    this.writer?.write(line);

    if (tool === "submit_final_report" && outcome.ok) this.close((rawArgs ?? null) as FinalReport);
    return outcome;
  }

  /** Ends the run without a report (e.g. agent disconnected). No-op if already ended. */
  close(report: FinalReport | null = null): void {
    if (this.endLine) return;
    this.endLine = { type: "end", t: this.clock.nowIso(), report };
    this.writer?.write(this.endLine);
  }

  private dispatch(tool: ToolName, args: any): { outcome: ToolOutcome; meta: Record<string, unknown> } {
    const p = this.provider;
    switch (tool) {
      case "search_hotels":
        return { outcome: toOutcome(p.searchHotels(args)), meta: {} };
      case "get_rates":
        return { outcome: toOutcome(p.getRates(args)), meta: {} };
      case "get_cancellation_policy":
        return { outcome: toOutcome(p.getCancellationPolicy(args)), meta: {} };
      case "prebook": {
        const r = p.prebook(args);
        if (r.ok) this.latestPrebook = { prebook_id: r.data.prebook_id, total: r.data.total_price, currency: r.data.currency };
        return { outcome: toOutcome(r), meta: {} };
      }
      case "book":
        return { outcome: toOutcome(p.book(args)), meta: {} };
      case "get_booking":
        return { outcome: toOutcome(p.getBooking(args)), meta: {} };
      case "cancel_booking":
        return { outcome: toOutcome(p.cancelBooking(args)), meta: {} };
      case "ask_traveler": {
        const a = this.traveler.answer(args.question, { latestPrebook: this.latestPrebook });
        return { outcome: { ok: true, data: { answer: a.answer } }, meta: { traveler: a.meta } };
      }
      case "wait":
        this.clock.advance(args.seconds);
        return { outcome: { ok: true, data: { waited_s: args.seconds, now: this.clock.nowIso() } }, meta: {} };
      case "submit_final_report":
        return {
          outcome: { ok: true, data: { accepted: true, message: "Final report received. The run is over." } },
          meta: {},
        };
    }
  }
}
