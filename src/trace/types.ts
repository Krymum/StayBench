import type { FaultSpec } from "../faults/types.js";
import type { WorldSpec } from "../simulator/types.js";
import type { TravelerSpec } from "../traveler/traveler.js";

export const TRACE_FORMAT_VERSION = 1;

/**
 * Everything needed to rebuild the exact same run. Embedded in the trace header so a
 * trace can be replayed and verified on its own.
 */
export interface RunConfig {
  scenario_id: string;
  scenario_version: number;
  /** sha256 of the scenario file, when the run comes from a scenario file. */
  scenario_hash?: string;
  start_time: string;
  /** Virtual seconds added before every tool call. */
  tick_s: number;
  world: WorldSpec;
  faults: FaultSpec[];
  traveler: TravelerSpec;
}

export interface TraceHeader {
  type: "header";
  format: number;
  staybench_version: string;
  run: RunConfig;
  /** Free-form info about the agent (model, client). Not used for grading. */
  agent?: Record<string, unknown>;
}

export interface ToolError {
  code: string;
  message: string;
  retry_after_s?: number;
}

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: ToolError };

export interface TraceCall {
  type: "call";
  seq: number;
  /** Virtual time at which the call was processed (after the tick). */
  t: string;
  tool: string;
  args: unknown;
  result: ToolOutcome;
  /** Ground-truth annotations hidden from the agent (traveler decisions, fault firings). */
  meta?: Record<string, unknown>;
}

export interface TraceEnd {
  type: "end";
  t: string;
  /** The final report as submitted, or null if the run ended without one. */
  report: unknown;
}

export type TraceLine = TraceHeader | TraceCall | TraceEnd;
