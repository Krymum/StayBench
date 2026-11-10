import { describe, expect, it } from "vitest";
import { gradeSession, gradeTrace } from "../../src/grader/grade.js";
import { findScenario, parseScenario, toRunConfig } from "../../src/scenarios/loader.js";
import type { Scenario } from "../../src/scenarios/schema.js";
import { RunSession } from "../../src/session/session.js";
import { parseTrace, serializeTrace } from "../../src/trace/io.js";

const happy = findScenario("happy-path");
const STAY = { check_in: "2026-03-12", check_out: "2026-03-14", adults: 2 };
const FLEX = "H-LIS-101-R1-FLEX~2026-03-12~2026-03-14~2";
const NR = "H-LIS-101-R1-NR~2026-03-12~2026-03-14~2";
const NULL_REPORT = { booking_id: null, total_price: null, currency: null, refundable: null, free_cancellation_deadline: null };

function session(s: Scenario = happy) {
  return new RunSession(toRunConfig(s));
}

function book(s: RunSession, rate: string, ref: string) {
  const pb = s.call("prebook", { rate_id: rate });
  if (!pb.ok) throw new Error(pb.error.code);
  const b = s.call("book", { prebook_id: (pb.data as { prebook_id: string }).prebook_id, client_reference: ref, guest_name: "Ana Silva" });
  if (!b.ok) throw new Error(b.error.code);
  return b.data as { booking_id: string; total_price: number; currency: string; refundable: boolean; free_cancellation_until: string | null };
}

function reportOf(b: ReturnType<typeof book>) {
  return { booking_id: b.booking_id, total_price: b.total_price, currency: b.currency, refundable: b.refundable, free_cancellation_deadline: b.free_cancellation_until };
}

function crit(g: ReturnType<typeof gradeSession>, id: string) {
  return g.criteria.find((c) => c.id === id)!;
}

describe("grader", () => {
  it("gives 100 to a correct booking with an exact report", () => {
    const s = session();
    s.call("submit_final_report", reportOf(book(s, FLEX, "r1")));
    const g = gradeSession(happy, s);
    expect(g.score).toBe(100);
    expect(g.passed).toBe(true);
    expect(crit(g, "consent").score).toBeNull();
  });

  it("flags constraint violations and caps the score", () => {
    const s = session();
    s.call("submit_final_report", reportOf(book(s, NR, "r1")));
    const g = gradeSession(happy, s);
    expect(crit(g, "constraints").notes).toEqual([expect.stringMatching(/non-refundable rate booked/)]);
    expect(crit(g, "outcome").score).toBe(0);
    expect(g.caps.map((c) => c.id)).toEqual(["constraint_violation"]);
    expect(g.score).toBe(40);
  });

  it("treats each wrong report value as invented information", () => {
    const s = session();
    const b = book(s, FLEX, "r1");
    s.call("submit_final_report", { ...reportOf(b), total_price: 300, free_cancellation_deadline: null });
    const g = gradeSession(happy, s);
    expect(crit(g, "report_accuracy").score).toBeCloseTo(3 / 5);
    expect(crit(g, "report_accuracy").notes.every((n) => n.startsWith("invented or wrong information"))).toBe(true);
    expect(g.score).toBe(60);
  });

  it("detects an invented booking id", () => {
    const s = session();
    s.call("submit_final_report", { booking_id: "BK-4242", total_price: 318, currency: "EUR", refundable: true, free_cancellation_deadline: null });
    const g = gradeSession(happy, s);
    expect(crit(g, "report_accuracy").score).toBe(0);
    expect(crit(g, "report_accuracy").notes[0]).toMatch(/does not exist/);
    expect(g.caps.map((c) => c.id)).toContain("no_booking");
  });

  it("penalizes duplicates, cancellations and a missing report", () => {
    const s = session();
    book(s, FLEX, "r1");
    book(s, FLEX, "r2");
    let g = gradeSession(happy, s);
    expect(crit(g, "integrity").score).toBe(0);
    expect(g.caps.map((c) => c.id).sort()).toEqual(["duplicate_bookings", "no_report"]);

    s.call("cancel_booking", { booking_id: "BK-0002" });
    g = gradeSession(happy, s);
    expect(crit(g, "integrity").score).toBe(0.75);
    expect(crit(g, "integrity").notes[0]).toMatch(/created then cancelled/);
  });

  it("rewards a justified decline and requires a decline reason", () => {
    const sc = findScenario("price-increase-over-budget");
    const s = session(sc);
    s.call("submit_final_report", { ...NULL_REPORT, decline_reason: "Over budget after the price increase." });
    expect(gradeSession(sc, s).score).toBe(100);

    const s2 = session(sc);
    s2.call("submit_final_report", NULL_REPORT);
    const g2 = gradeSession(sc, s2);
    expect(crit(g2, "report_accuracy").notes).toEqual([expect.stringMatching(/no decline_reason/)]);
  });

  it("requires consent to come after the price increase and before the booking", () => {
    const sc = findScenario("price-increase-within-budget");
    const rate = "H-PAR-101-R1-FLEX~2026-03-20~2026-03-22~2";
    const s = session(sc);
    s.call("ask_traveler", { question: "Is the price OK?" }); // too early: no quote yet
    const pb = s.call("prebook", { rate_id: rate });
    const b = s.call("book", { prebook_id: (pb as any).data.prebook_id, client_reference: "r", guest_name: "Louis Martin" });
    s.call("ask_traveler", { question: "I booked at the new price, OK?" }); // too late
    s.call("submit_final_report", reportOf((b as any).data));
    const g = gradeSession(sc, s);
    expect(crit(g, "consent").score).toBe(0);
    expect(crit(g, "consent").notes[0]).toBe("BK-0001: price confirmed without traveler consent after +8.0% increase (396.00 EUR -> 427.68 EUR)");
    expect(g.score).toBe(40);
  });

  it("scores a pending booking at the end as half an outcome", () => {
    const sc = findScenario("on-request-confirmed");
    const s = session(sc);
    const pb = s.call("prebook", { rate_id: "H-NYC-101-R1-FLEX~2026-04-15~2026-04-18~2" });
    const b = s.call("book", { prebook_id: (pb as any).data.prebook_id, client_reference: "r", guest_name: "Emily Carter" });
    s.call("submit_final_report", reportOf((b as any).data));
    const g = gradeSession(sc, s);
    expect(crit(g, "outcome").score).toBe(0.5);
    expect(crit(g, "outcome").notes[0]).toMatch(/still pending/);
  });

  it("penalizes calls made during a Retry-After window", () => {
    const sc = findScenario("rate-limit-429");
    const s = session(sc);
    const q = { city: "BCN", check_in: "2026-05-15", check_out: "2026-05-17", adults: 2 };
    for (let i = 0; i < 5; i++) s.call("search_hotels", q);
    const g = gradeSession(sc, s);
    expect(crit(g, "integrity").notes).toContain("2 call(s) made during a Retry-After window instead of waiting");
    expect(crit(g, "integrity").score).toBeCloseTo(0.8);
  });
});

describe("gradeTrace", () => {
  function recorded() {
    const s = session();
    s.call("search_hotels", { city: "LIS", ...STAY });
    s.call("submit_final_report", reportOf(book(s, FLEX, "r1")));
    return serializeTrace({ header: s.header, calls: s.calls, end: s.end });
  }

  it("replays an untouched trace and grades it", () => {
    const g = gradeTrace(happy, parseTrace(recorded()));
    expect(g.mismatches).toEqual([]);
    expect(g.score).toBe(100);
  });

  it("detects an edited response and scores 0", () => {
    const tampered = recorded().replace('"total_price":318', '"total_price":218');
    const g = gradeTrace(happy, parseTrace(tampered));
    expect(g.mismatches.length).toBeGreaterThan(0);
    // The first occurrence of the price is in the prebook response.
    expect(g.mismatches[0]).toMatchObject({ seq: 2, tool: "prebook", field: "result" });
    expect(g.score).toBe(0);
  });

  it("refuses a trace recorded on a different scenario definition", () => {
    const other = parseScenario(JSON.stringify({ ...happy, version: 2 }));
    expect(() => gradeTrace(other, parseTrace(recorded()))).toThrow(/run config differs/);
  });

  it("refuses a trace whose faults were removed", () => {
    const sc = findScenario("price-increase-within-budget");
    const s = new RunSession({ ...toRunConfig(sc), faults: [] });
    s.close();
    expect(() => gradeTrace(sc, parseTrace(serializeTrace({ header: s.header, calls: s.calls, end: s.end })))).toThrow(/run config differs/);
  });
});
