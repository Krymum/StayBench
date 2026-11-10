import { canonicalJson } from "../scenarios/loader.js";
import { RunSession } from "../session/session.js";
import type { ParsedTrace } from "./io.js";

export interface ReplayMismatch {
  seq: number;
  tool: string;
  field: "result" | "meta" | "t" | "end";
  expected: unknown;
  actual: unknown;
}

export interface ReplayResult {
  session: RunSession;
  mismatches: ReplayMismatch[];
}

/**
 * Re-executes every recorded call against a fresh simulator built from the trace header,
 * and checks that each recorded response is exactly what the simulator returns.
 * A consistent trace proves the responses were not edited; it does not prove which agent
 * produced the calls.
 */
export function replayTrace(trace: ParsedTrace): ReplayResult {
  const session = new RunSession(trace.header.run);
  const mismatches: ReplayMismatch[] = [];
  for (const call of trace.calls) {
    session.call(call.tool, call.args);
    const got = session.calls[session.calls.length - 1];
    if (!got) {
      mismatches.push({ seq: call.seq, tool: call.tool, field: "result", expected: call.result, actual: "(call refused: run already finished)" });
      continue;
    }
    if (canonicalJson(got.result) !== canonicalJson(call.result)) {
      mismatches.push({ seq: call.seq, tool: call.tool, field: "result", expected: call.result, actual: got.result });
    }
    if (canonicalJson(got.meta ?? null) !== canonicalJson(call.meta ?? null)) {
      mismatches.push({ seq: call.seq, tool: call.tool, field: "meta", expected: call.meta, actual: got.meta });
    }
    if (got.t !== call.t) mismatches.push({ seq: call.seq, tool: call.tool, field: "t", expected: call.t, actual: got.t });
  }
  if (trace.end && !session.finished) session.close(null);
  if (trace.end && canonicalJson(session.end?.report ?? null) !== canonicalJson(trace.end.report)) {
    mismatches.push({ seq: trace.calls.length + 1, tool: "(end)", field: "end", expected: trace.end.report, actual: session.end?.report ?? null });
  }
  return { session, mismatches };
}
