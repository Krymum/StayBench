import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/core/clock.js";
import { daysBefore, isIsoDate, nightsBetween } from "../../src/core/dates.js";
import { applyPercent, money, percentChange, percentOf, toMajor } from "../../src/core/money.js";
import { Rng, hash32 } from "../../src/core/rng.js";

describe("Rng", () => {
  it("produces the same sequence for the same seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    expect(new Rng(1).next()).not.toEqual(new Rng(2).next());
  });

  it("is pinned to known values (guards against accidental algorithm changes)", () => {
    const r = new Rng(12345);
    const values = [r.int(0, 1000), r.int(0, 1000), r.int(0, 1000)];
    expect(values).toMatchInlineSnapshot(`
      [
        980,
        307,
        484,
      ]
    `);
  });

  it("int stays within inclusive bounds", () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 5);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it("forks are independent of parent consumption", () => {
    const a = new Rng(9);
    a.next();
    a.next();
    expect(a.fork("x").next()).toEqual(new Rng(9).fork("x").next());
    expect(new Rng(9).fork("x").next()).not.toEqual(new Rng(9).fork("y").next());
  });

  it("shuffle keeps all elements", () => {
    expect(new Rng(3).shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("hash32 is stable", () => {
    expect(hash32("staybench")).toBe(hash32("staybench"));
    expect(hash32("a")).not.toBe(hash32("b"));
  });
});

describe("VirtualClock", () => {
  it("only moves when advanced", () => {
    const c = new VirtualClock("2026-02-01T09:00:00Z");
    expect(c.nowIso()).toBe("2026-02-01T09:00:00.000Z");
    c.advance(90);
    expect(c.nowIso()).toBe("2026-02-01T09:01:30.000Z");
  });

  it("rejects negative or invalid input", () => {
    expect(() => new VirtualClock("nope")).toThrow();
    expect(() => new VirtualClock(0).advance(-1)).toThrow();
  });
});

describe("money", () => {
  it("converts between major and minor units", () => {
    expect(money(450, "EUR").minor).toBe(45000);
    expect(money(19.99, "EUR").minor).toBe(1999);
    expect(toMajor(45210)).toBe(452.1);
  });

  it("applies percentages with half-up rounding", () => {
    expect(applyPercent(20000, 18)).toBe(23600);
    expect(applyPercent(20000, -6)).toBe(18800);
    expect(applyPercent(1001, 50)).toBe(1502); // 1501.5 -> 1502
    expect(percentOf(20000, 14.75)).toBe(2950);
  });

  it("computes relative change", () => {
    expect(percentChange(21200, 25016)).toBe(18);
    expect(percentChange(0, 10)).toBe(0);
  });
});

describe("dates", () => {
  it("validates ISO dates strictly", () => {
    expect(isIsoDate("2026-03-12")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("12/03/2026")).toBe(false);
  });

  it("counts nights and deadlines in UTC", () => {
    expect(nightsBetween("2026-03-12", "2026-03-14")).toBe(2);
    expect(nightsBetween("2026-03-28", "2026-03-30")).toBe(2); // across EU DST change
    expect(daysBefore("2026-03-12", 3)).toBe("2026-03-09T00:00:00.000Z");
  });
});
