import { describe, expect, it } from "vitest";
import { runAgent } from "../../src/agents/run-local.js";
import { ScriptedBadAgent } from "../../src/agents/scripted-bad.js";
import { ScriptedGoodAgent } from "../../src/agents/scripted-good.js";
import { explain, gradeSession, gradeTrace } from "../../src/grader/grade.js";
import { loadScenarios, toRunConfig } from "../../src/scenarios/loader.js";
import { parseTrace, serializeTrace } from "../../src/trace/io.js";

const scenarios = loadScenarios();

/** Expected good-agent reports, computed by hand from each scenario (guards the arithmetic). */
const EXPECTED_REPORTS: Record<string, { total_price: number | null; currency: string | null; deadline: string | null }> = {
  "happy-path": { total_price: 318, currency: "EUR", deadline: "2026-03-09T00:00:00.000Z" },
  "price-increase-within-budget": { total_price: 427.68, currency: "EUR", deadline: "2026-03-18T00:00:00.000Z" },
  "price-increase-over-budget": { total_price: null, currency: null, deadline: null },
  "price-decrease": { total_price: 496.32, currency: "EUR", deadline: "2026-03-31T00:00:00.000Z" },
  "soldout-search-to-prebook": { total_price: 374, currency: "EUR", deadline: "2026-03-23T00:00:00.000Z" },
  "soldout-prebook-to-book": { total_price: 288.9, currency: "EUR", deadline: "2026-05-09T00:00:00.000Z" },
  "on-request-confirmed": { total_price: 1032.75, currency: "USD", deadline: "2026-04-12T00:00:00.000Z" },
  "on-request-rejected": { total_price: 492, currency: "GBP", deadline: "2026-03-03T00:00:00.000Z" },
  "timeout-ghost-booking": { total_price: 604.2, currency: "EUR", deadline: "2026-05-29T00:00:00.000Z" },
  "duplicate-reference": { total_price: 418, currency: "EUR", deadline: "2026-04-18T00:00:00.000Z" },
  "rate-limit-429": { total_price: 308, currency: "EUR", deadline: "2026-05-13T00:00:00.000Z" },
  "prebook-expired-requote": { total_price: 358.05, currency: "EUR", deadline: "2026-04-06T00:00:00.000Z" },
  "mislabeled-nonrefundable": { total_price: 561.75, currency: "EUR", deadline: "2026-06-08T00:00:00.000Z" },
  "taxes-excluded-budget": { total_price: 384, currency: "GBP", deadline: "2026-04-30T00:00:00.000Z" },
  "near-identical-rooms": { total_price: 626.4, currency: "CHF", deadline: "2026-03-16T00:00:00.000Z" },
  "last-minute-free-cancellation": { total_price: 360.4, currency: "EUR", deadline: "2026-03-11T00:00:00.000Z" },
  "minimum-star-rating": { total_price: 407, currency: "EUR", deadline: "2026-04-18T00:00:00.000Z" },
  "breakfast-included": { total_price: 396, currency: "EUR", deadline: "2026-05-03T00:00:00.000Z" },
  "price-jump-switch-hotel": { total_price: 418, currency: "EUR", deadline: "2026-05-10T00:00:00.000Z" },
  "ghost-booking-rate-limited": { total_price: 688.5, currency: "USD", deadline: "2026-06-06T00:00:00.000Z" },
  "all-sold-out": { total_price: null, currency: null, deadline: null },
  "two-rooms-family": { total_price: 636, currency: "EUR", deadline: "2026-07-01T00:00:00.000Z" },
  "last-room-available": { total_price: 836, currency: "EUR", deadline: "2026-09-16T00:00:00.000Z" },
};

describe("scenario catalog", () => {
  it("has 23 scenarios with unique ids, each with an expected report", () => {
    expect(scenarios).toHaveLength(23);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(23);
    expect(Object.keys(EXPECTED_REPORTS).sort()).toEqual(scenarios.map((s) => s.id).sort());
  });

  it("covers every fault type", () => {
    const types = new Set(scenarios.flatMap((s) => s.faults.map((f) => f.type)));
    expect([...types].sort()).toEqual(
      ["duplicate_reference", "error", "mislabeled_refundable", "on_request", "price_change", "rate_limit", "sold_out", "taxes_excluded"],
    );
  });
});

describe.each(scenarios.map((s) => [s.id, s] as const))("scenario %s", (_id, scenario) => {
  it("scripted-good scores 100 with the expected report", { timeout: 10_000 }, async () => {
    const session = await runAgent(new ScriptedGoodAgent(), scenario);
    const g = gradeSession(scenario, session);
    expect(g.score, explain({ ...g, mismatches: [] })).toBe(100);
    const exp = EXPECTED_REPORTS[scenario.id]!;
    expect(session.report).toMatchObject({ total_price: exp.total_price, currency: exp.currency, free_cancellation_deadline: exp.deadline });
  });

  it("scripted-bad fails the criteria the scenario focuses on", { timeout: 10_000 }, async () => {
    const g = gradeSession(scenario, await runAgent(new ScriptedBadAgent(), scenario));
    const msg = explain({ ...g, mismatches: [] });
    expect(g.passed, msg).toBe(false);
    for (const id of scenario.expected.focus) {
      const c = g.criteria.find((x) => x.id === id)!;
      if (c.score !== null) expect(c.score, `${id}\n${msg}`).toBeLessThan(1);
    }
  });

  it("is deterministic and its trace replays and grades identically", { timeout: 10_000 }, async () => {
    const a = await runAgent(new ScriptedGoodAgent(), scenario);
    const b = await runAgent(new ScriptedGoodAgent(), scenario);
    const ta = serializeTrace({ header: a.header, calls: a.calls, end: a.end });
    expect(serializeTrace({ header: b.header, calls: b.calls, end: b.end })).toBe(ta);
    const g = gradeTrace(scenario, parseTrace(ta));
    expect(g.mismatches).toEqual([]);
    expect(g.score).toBe(100);
    expect(a.header.run).toEqual(toRunConfig(scenario));
  });
});
