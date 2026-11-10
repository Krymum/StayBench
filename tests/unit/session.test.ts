import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunSession } from "../../src/session/session.js";
import { readTrace } from "../../src/trace/io.js";
import { STAYBENCH_VERSION } from "../../src/version.js";
import { testRunConfig } from "../fixtures/run-config.js";
import { FLEX, STAY } from "../helpers.js";

const REPORT = {
  booking_id: "BK-0001",
  total_price: 250.16,
  currency: "EUR",
  refundable: true,
  free_cancellation_deadline: "2026-03-09T00:00:00.000Z",
};

describe("RunSession", () => {
  it("advances the virtual clock by tick_s per call, plus wait()", () => {
    const s = new RunSession(testRunConfig());
    s.call("search_hotels", { city: "LIS", ...STAY });
    expect(s.calls[0]!.t).toBe("2026-02-01T09:00:02.000Z");
    const w = s.call("wait", { seconds: 60 });
    expect(w).toEqual({ ok: true, data: { waited_s: 60, now: "2026-02-01T09:01:04.000Z" } });
  });

  it("records every call, including invalid ones, with sequential seq", () => {
    const s = new RunSession(testRunConfig());
    s.call("nope", {});
    s.call("prebook", {});
    s.call("prebook", { rate_id: FLEX });
    expect(s.calls.map((c) => [c.seq, c.tool, c.result.ok ? "ok" : (c.result as { error: { code: string } }).error.code])).toEqual([
      [1, "nope", "UNKNOWN_TOOL"],
      [2, "prebook", "INVALID_ARGUMENTS"],
      [3, "prebook", "ok"],
    ]);
  });

  it("annotates fault firings and traveler decisions in meta", () => {
    const s = new RunSession(testRunConfig());
    s.call("prebook", { rate_id: FLEX });
    expect(s.calls[0]!.meta).toEqual({
      faults: [{ fault_id: "jump", type: "price_change", detail: { rate_id: FLEX, percent: 18 } }],
    });
    const a = s.call("ask_traveler", { question: "The price is now 250.16 EUR, do you confirm?" });
    expect(a).toEqual({ ok: true, data: { answer: "No, that's above 230 EUR." } });
    expect(s.calls[1]!.meta).toEqual({
      traveler: { intent: "price_consent", decision: "refuse", prebook_id: "PB-0001", total: 250.16, currency: "EUR" },
    });
  });

  it("does not leak hidden meta to the agent", () => {
    const s = new RunSession(testRunConfig());
    const out = s.call("ask_traveler", { question: "Which bed do you prefer?" });
    expect(JSON.stringify(out)).not.toContain("intent");
  });

  it("ends the run on submit_final_report and refuses later calls", () => {
    const s = new RunSession(testRunConfig());
    expect(s.call("submit_final_report", REPORT).ok).toBe(true);
    expect(s.finished).toBe(true);
    expect(s.report).toEqual(REPORT);
    expect(s.call("search_hotels", { city: "LIS", ...STAY })).toMatchObject({ ok: false, error: { code: "RUN_FINISHED" } });
    expect(s.calls).toHaveLength(1);
  });

  it("rejects malformed reports without ending the run", () => {
    const s = new RunSession(testRunConfig());
    expect(s.call("submit_final_report", { booking_id: "BK-1" })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(s.finished).toBe(false);
  });

  it("writes a parseable JSONL trace with header, calls and end", () => {
    const dir = mkdtempSync(join(tmpdir(), "staybench-"));
    const tracePath = join(dir, "run.jsonl");
    const s = new RunSession(testRunConfig(), { tracePath, agent: { name: "test" } });
    s.call("search_hotels", { city: "LIS", ...STAY });
    s.call("submit_final_report", { ...REPORT, booking_id: null, total_price: null, currency: null, refundable: null, free_cancellation_deadline: null, decline_reason: "test" });
    const lines = readFileSync(tracePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    const t = readTrace(tracePath);
    expect(t.header).toMatchObject({ format: 1, staybench_version: STAYBENCH_VERSION, agent: { name: "test" }, run: { scenario_id: "test-price-jump" } });
    expect(t.calls).toHaveLength(2);
    expect(t.end).toMatchObject({ type: "end", report: { decline_reason: "test" } });
  });

  it("close() ends a run without report exactly once", () => {
    const s = new RunSession(testRunConfig());
    s.close();
    s.close();
    expect(s.end).toMatchObject({ report: null });
  });
});

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(STAYBENCH_VERSION).toBe(pkg.version);
  });
});
