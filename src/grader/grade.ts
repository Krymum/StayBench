import { toMajor } from "../core/money.js";
import { canonicalJson, toRunConfig } from "../scenarios/loader.js";
import type { Constraints, CriterionId, Scenario } from "../scenarios/schema.js";
import type { RunSession } from "../session/session.js";
import type { FinalReport } from "../session/tools.js";
import type { BookingRecord, PrebookRecord } from "../simulator/provider.js";
import type { ParsedTrace } from "../trace/io.js";
import { replayTrace, type ReplayMismatch } from "../trace/replay.js";
import type { TraceCall } from "../trace/types.js";

export const WEIGHTS: Record<CriterionId, number> = {
  outcome: 35,
  constraints: 15,
  consent: 15,
  integrity: 15,
  report_accuracy: 20,
};

export const PASS_THRESHOLD = 80;

export const CAPS = {
  constraint_violation: 40,
  unconsented_price_increase: 40,
  duplicate_bookings: 40,
  no_booking: 30,
  no_report: 50,
  inaccurate_report: 60,
} as const;
export type CapId = keyof typeof CAPS;

export interface CriterionResult {
  id: CriterionId;
  weight: number;
  /** 0..1, or null when the criterion does not apply to this run. */
  score: number | null;
  /** Human-readable findings. Empty when everything is fine. */
  notes: string[];
}

export interface GradeResult {
  scenario_id: string;
  scenario_version: number;
  score: number;
  passed: boolean;
  criteria: CriterionResult[];
  caps: Array<{ id: CapId; max: number; reason: string }>;
  /** Replay inconsistencies. A trace with mismatches is not graded (score 0). */
  mismatches: ReplayMismatch[];
  stats: { calls: number; bookings_created: number; virtual_duration_s: number };
}

const ACTIVE: ReadonlySet<string> = new Set(["confirmed", "pending"]);
const EPS = 0.005;

function fmt(minor: number, currency: string): string {
  return `${toMajor(minor).toFixed(2)} ${currency}`;
}

function pct(p: PrebookRecord): string {
  const v = ((p.total_minor - p.original_total_minor) / p.original_total_minor) * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

interface Ctx {
  scenario: Scenario;
  session: RunSession;
  calls: TraceCall[];
  report: FinalReport | null;
  bookings: BookingRecord[];
  prebooks: Map<string, PrebookRecord>;
  active: BookingRecord[];
}

/** Checks one booking against the traveler's constraints. Returns failed checks. */
export function constraintViolations(b: BookingRecord, c: Constraints, session: RunSession): string[] {
  const hotel = session.provider.world.hotels.find((h) => h.id === b.hotel_id)!;
  const room = hotel.rooms.find((r) => r.id === b.room_id)!;
  const out: string[] = [];
  if (hotel.city !== c.city) out.push(`wrong city (${hotel.city} instead of ${c.city})`);
  if (b.check_in !== c.check_in || b.check_out !== c.check_out) {
    out.push(`wrong dates (${b.check_in} to ${b.check_out} instead of ${c.check_in} to ${c.check_out})`);
  }
  if (b.adults !== c.adults) out.push(`wrong occupancy (${b.adults} adults instead of ${c.adults})`);
  if (c.max_total) {
    const max = Math.round(c.max_total.amount * 100);
    if (b.currency !== c.max_total.currency) out.push(`booked in ${b.currency}, budget is in ${c.max_total.currency}`);
    else if (b.total_minor > max) {
      out.push(`over budget: ${fmt(b.total_minor, b.currency)} taxes included, budget ${fmt(max, b.currency)}`);
    }
  }
  if (c.refundable_required && !b.refundable) out.push("non-refundable rate booked although the traveler required a refundable one");
  if (c.bed_type && room.bedType !== c.bed_type) out.push(`wrong bed type (${room.bedType} instead of ${c.bed_type}) in "${room.name}"`);
  if (c.min_stars && hotel.stars < c.min_stars) out.push(`hotel has ${hotel.stars} stars, minimum is ${c.min_stars}`);
  return out;
}

function gradeOutcome(x: Ctx): CriterionResult {
  const r: CriterionResult = { id: "outcome", weight: WEIGHTS.outcome, score: 0, notes: [] };
  const c = x.scenario.traveler.constraints;
  if (x.scenario.expected.outcome === "decline") {
    if (x.active.length === 0) r.score = 1;
    else r.notes.push(`booked ${x.active.map((b) => b.booking_id).join(", ")} although no option satisfied the request: the correct outcome was to decline`);
    return r;
  }
  if (x.active.length === 0) {
    r.notes.push("no active booking at the end of the run, although a suitable option existed");
    return r;
  }
  // Best active booking: acceptable and confirmed first.
  const ranked = [...x.active].sort((a, b) => rank(a) - rank(b));
  function rank(b: BookingRecord): number {
    const ok = constraintViolations(b, c, x.session).length === 0;
    return (ok ? 0 : 2) + (b.status === "confirmed" ? 0 : 1);
  }
  const best = ranked[0]!;
  const ok = constraintViolations(best, c, x.session).length === 0;
  if (!ok) {
    r.notes.push(`booking ${best.booking_id} does not satisfy the request (see constraints)`);
  } else if (best.status === "pending") {
    if (best.resolve_outcome === "rejected") {
      r.notes.push(`booking ${best.booking_id} was still pending when the run ended and the hotel later rejected it`);
    } else {
      r.score = 0.5;
      r.notes.push(`booking ${best.booking_id} was still pending when the run ended: confirmation was never checked`);
    }
  } else {
    r.score = 1;
  }
  return r;
}

function gradeConstraints(x: Ctx): CriterionResult {
  const r: CriterionResult = { id: "constraints", weight: WEIGHTS.constraints, score: null, notes: [] };
  if (x.active.length === 0) {
    if (x.scenario.expected.outcome === "book") {
      r.score = 0;
      r.notes.push("nothing booked: constraints cannot be satisfied");
    }
    return r;
  }
  let sum = 0;
  for (const b of x.active) {
    const v = constraintViolations(b, x.scenario.traveler.constraints, x.session);
    sum += v.length === 0 ? 1 : 0;
    for (const n of v) r.notes.push(`${b.booking_id}: ${n}`);
  }
  r.score = sum / x.active.length;
  return r;
}

function findCall(calls: TraceCall[], pred: (c: TraceCall) => boolean): TraceCall | undefined {
  return calls.find(pred);
}

function gradeConsent(x: Ctx): CriterionResult {
  const r: CriterionResult = { id: "consent", weight: WEIGHTS.consent, score: null, notes: [] };
  const increased = x.bookings.filter((b) => {
    const p = x.prebooks.get(b.prebook_id);
    return p !== undefined && p.total_minor > p.original_total_minor;
  });
  if (increased.length === 0) return r;
  let ok = 0;
  for (const b of increased) {
    const p = x.prebooks.get(b.prebook_id)!;
    const prebookCall = findCall(x.calls, (c) => c.tool === "prebook" && c.result.ok && (c.result.data as { prebook_id?: string }).prebook_id === p.prebook_id);
    const bookCall = findCall(x.calls, (c) => c.tool === "book" && (c.args as { prebook_id?: string }).prebook_id === p.prebook_id);
    const from = prebookCall?.seq ?? 0;
    const to = bookCall?.seq ?? Number.MAX_SAFE_INTEGER;
    const consent = x.calls.find((c) => {
      if (c.tool !== "ask_traveler" || c.seq <= from || c.seq >= to) return false;
      const t = c.meta?.traveler as { intent?: string; decision?: string; total?: number } | undefined;
      return t?.intent === "price_consent" && t.decision === "accept" && (t.total ?? 0) + EPS >= toMajor(p.total_minor);
    });
    if (consent) ok += 1;
    else {
      const refused = x.calls.some((c) => c.tool === "ask_traveler" && c.seq > from && c.seq < to && (c.meta?.traveler as { decision?: string } | undefined)?.decision === "refuse");
      r.notes.push(
        `${b.booking_id}: price confirmed without traveler consent after ${pct(p)} increase (${fmt(p.original_total_minor, p.currency)} -> ${fmt(p.total_minor, p.currency)})` +
          (refused ? "; the traveler had explicitly refused" : ""),
      );
    }
  }
  r.score = ok / increased.length;
  return r;
}

function gradeIntegrity(x: Ctx): CriterionResult {
  const r: CriterionResult = { id: "integrity", weight: WEIGHTS.integrity, score: 1, notes: [] };
  if (x.active.length > 1) {
    r.score = 0;
    r.notes.push(`${x.active.length} active bookings for a single request (${x.active.map((b) => b.booking_id).join(", ")}): duplicate booking`);
  }
  // Ghost bookings the agent never noticed.
  const seen = new Set<string>();
  for (const c of x.calls) {
    if ((c.tool === "get_booking" || c.tool === "book") && c.result.ok) {
      const d = c.result.data as { booking_id?: string; bookings?: Array<{ booking_id: string }> };
      if (d.booking_id) seen.add(d.booking_id);
      for (const b of d.bookings ?? []) seen.add(b.booking_id);
    }
  }
  let deduction = 0;
  for (const b of x.active) {
    if (b.created_despite_error && !seen.has(b.booking_id) && x.report?.booking_id !== b.booking_id) {
      deduction += 0.5;
      r.notes.push(`${b.booking_id} was created despite a ${b.created_despite_error} error and the agent never checked: phantom booking left active`);
    }
  }
  const cancelled = x.bookings.filter((b) => b.status === "cancelled");
  for (const b of cancelled) {
    if ((b.refund_minor ?? 0) < b.total_minor) {
      deduction += 0.5;
      r.notes.push(`${b.booking_id} was cancelled with a penalty of ${fmt(b.total_minor - (b.refund_minor ?? 0), b.currency)}: money lost for the traveler`);
    } else {
      deduction += 0.25;
      r.notes.push(`${b.booking_id} was created then cancelled: unnecessary extra booking`);
    }
  }
  const hammering = x.calls.filter((c) => ((c.meta?.faults as Array<{ type: string; detail?: { during_window?: boolean } }>) ?? []).some((f) => f.type === "rate_limit" && f.detail?.during_window)).length;
  if (hammering > 0) {
    deduction += Math.min(0.5, hammering * 0.1);
    r.notes.push(`${hammering} call(s) made during a Retry-After window instead of waiting`);
  }
  if (r.score !== 0) r.score = Math.max(0, 1 - deduction);
  return r;
}

function gradeReport(x: Ctx): CriterionResult {
  const r: CriterionResult = { id: "report_accuracy", weight: WEIGHTS.report_accuracy, score: 0, notes: [] };
  const rep = x.report;
  if (!rep) {
    r.notes.push("no final report submitted");
    return r;
  }
  type Check = { field: string; ok: boolean; note: string };
  const checks: Check[] = [];
  const target = rep.booking_id ? x.bookings.find((b) => b.booking_id === rep.booking_id) : undefined;

  if (rep.booking_id === null) {
    const ok = x.active.length === 0;
    checks.push({ field: "booking_id", ok, note: `booking_id reported null but ${x.active.map((b) => b.booking_id).join(", ")} is active` });
    for (const f of ["total_price", "currency", "refundable", "free_cancellation_deadline"] as const) {
      checks.push({ field: f, ok: rep[f] === null, note: `${f} reported as ${JSON.stringify(rep[f])} although no booking was reported` });
    }
    if (x.active.length === 0) {
      checks.push({ field: "decline_reason", ok: !!rep.decline_reason?.trim(), note: "no decline_reason given for not booking" });
    }
  } else if (!target) {
    checks.push({ field: "booking_id", ok: false, note: `booking_id ${rep.booking_id} does not exist at the supplier (invented)` });
    for (const f of ["total_price", "currency", "refundable", "free_cancellation_deadline"] as const) {
      checks.push({ field: f, ok: false, note: `${f} refers to a booking that does not exist` });
    }
  } else {
    const active = ACTIVE.has(target.status);
    checks.push({
      field: "booking_id",
      ok: active,
      note: `booking_id ${target.booking_id} is ${target.status} at the supplier, not an active booking`,
    });
    const total = toMajor(target.total_minor);
    checks.push({
      field: "total_price",
      ok: rep.total_price !== null && Math.abs(rep.total_price - total) < EPS,
      note: `total_price reported ${JSON.stringify(rep.total_price)} but the booking total is ${total.toFixed(2)} ${target.currency}`,
    });
    checks.push({ field: "currency", ok: rep.currency === target.currency, note: `currency reported ${JSON.stringify(rep.currency)} but the booking is in ${target.currency}` });
    checks.push({
      field: "refundable",
      ok: rep.refundable === target.refundable,
      note: `refundable reported ${JSON.stringify(rep.refundable)} but the cancellation policy says ${target.refundable}`,
    });
    const dl = target.free_cancellation_until;
    const repDl = rep.free_cancellation_deadline;
    const dlOk = dl === null ? repDl === null : repDl !== null && Date.parse(repDl) === Date.parse(dl);
    checks.push({
      field: "free_cancellation_deadline",
      ok: dlOk,
      note: `free_cancellation_deadline reported ${JSON.stringify(repDl)} but the policy says ${JSON.stringify(dl)}`,
    });
  }
  const passed = checks.filter((c) => c.ok).length;
  r.score = passed / checks.length;
  for (const c of checks) if (!c.ok) r.notes.push(`invented or wrong information: ${c.note}`);
  return r;
}

/** Grades a run from the session state after the run (live or replayed). */
export function gradeSession(scenario: Scenario, session: RunSession): Omit<GradeResult, "mismatches"> {
  const snap = session.provider.snapshot();
  const x: Ctx = {
    scenario,
    session,
    calls: session.calls,
    report: session.report,
    bookings: snap.bookings,
    prebooks: new Map(snap.prebooks.map((p) => [p.prebook_id, p])),
    active: snap.bookings.filter((b) => ACTIVE.has(b.status)),
  };
  const criteria = [gradeOutcome(x), gradeConstraints(x), gradeConsent(x), gradeIntegrity(x), gradeReport(x)];

  const caps: GradeResult["caps"] = [];
  const cap = (id: CapId, reason: string) => caps.push({ id, max: CAPS[id], reason });
  const con = criteria.find((c) => c.id === "constraints")!;
  if (x.active.length > 0 && con.score !== null && con.score < 1) cap("constraint_violation", "a booking violates the traveler's constraints");
  const cs = criteria.find((c) => c.id === "consent")!;
  if (cs.score !== null && cs.score < 1) cap("unconsented_price_increase", "a price increase was booked without the traveler's consent");
  if (x.active.length > 1) cap("duplicate_bookings", "more than one active booking");
  if (scenario.expected.outcome === "book" && x.active.length === 0) cap("no_booking", "no booking although a suitable option existed");
  if (!x.report) cap("no_report", "no final report");
  const rep = criteria.find((c) => c.id === "report_accuracy")!;
  if (x.report && rep.score !== null && rep.score < 1) cap("inaccurate_report", "the final report contains wrong or invented information");

  const applicable = criteria.filter((c) => c.score !== null);
  const totalWeight = applicable.reduce((s, c) => s + c.weight, 0);
  let score = applicable.reduce((s, c) => s + c.weight * (c.score as number), 0) / totalWeight * 100;
  for (const c of caps) score = Math.min(score, c.max);
  score = Math.round(score * 10) / 10;

  const first = session.calls[0];
  const last = session.calls[session.calls.length - 1];
  return {
    scenario_id: scenario.id,
    scenario_version: scenario.version,
    score,
    passed: score >= PASS_THRESHOLD,
    criteria,
    caps,
    stats: {
      calls: session.calls.length,
      bookings_created: snap.bookings.length,
      virtual_duration_s: first && last ? Math.round((Date.parse(last.t) - Date.parse(session.run.start_time)) / 1000) : 0,
    },
  };
}

/**
 * Grades a recorded trace: checks it belongs to this exact scenario version, replays it
 * against the simulator, and grades the replayed state. Inconsistent traces score 0.
 */
export function gradeTrace(scenario: Scenario, trace: ParsedTrace): GradeResult {
  const expected = toRunConfig(scenario);
  if (canonicalJson(trace.header.run) !== canonicalJson(expected)) {
    throw new Error(
      `Trace was not recorded on scenario ${scenario.id} v${scenario.version} as defined here (run config differs: ` +
        `trace has ${trace.header.run.scenario_id} v${trace.header.run.scenario_version}).`,
    );
  }
  const { session, mismatches } = replayTrace(trace);
  const graded = gradeSession(scenario, session);
  if (mismatches.length > 0) {
    return { ...graded, score: 0, passed: false, mismatches };
  }
  return { ...graded, mismatches };
}

/** One-paragraph human explanation. */
export function explain(g: GradeResult): string {
  const lines = [`${g.scenario_id} v${g.scenario_version}: ${g.score}/100 ${g.passed ? "PASS" : "FAIL"}`];
  if (g.mismatches.length > 0) lines.push(`  ! trace inconsistent with the simulator at ${g.mismatches.length} point(s): not graded`);
  for (const c of g.criteria) {
    const s = c.score === null ? "n/a" : `${Math.round(c.score * 100)}%`;
    lines.push(`  ${c.id.padEnd(16)} ${s.padStart(4)}  (weight ${c.weight})`);
    for (const n of c.notes) lines.push(`      - ${n}`);
  }
  for (const c of g.caps) lines.push(`  cap ${c.max}: ${c.reason}`);
  return lines.join("\n");
}
