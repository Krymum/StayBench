import { describe, expect, it } from "vitest";
import { gradeSession } from "../../src/grader/grade.js";
import { parseScenario, toRunConfig } from "../../src/scenarios/loader.js";
import { RunSession } from "../../src/session/session.js";
import type { HotelSpec } from "../../src/simulator/types.js";
import { FLEX, STAY, TEST_HOTEL, errCode, must, setup } from "../helpers.js";

/** Same as TEST_HOTEL, but only one double room left at the FLEX rate. */
const SCARCE: HotelSpec = {
  ...TEST_HOTEL,
  rooms: TEST_HOTEL.rooms.map((r, i) =>
    i === 0 ? { ...r, plans: r.plans.map((p) => (p.code === "FLEX" ? { ...p, available_rooms: 1 } : p)) } : r,
  ),
};
const FLEX_2 = `${FLEX}~2`;

describe("multi-room supplier", () => {
  it("prices every room and only suffixes rate ids for 2+ rooms", () => {
    const { provider } = setup();
    const one = must(provider.getRates({ hotel_id: "H-T-001", ...STAY }));
    const two = must(provider.getRates({ hotel_id: "H-T-001", ...STAY, rooms: 2 }));
    expect(one.rooms[0]!.rates[0]).toMatchObject({ rate_id: FLEX, total_price: 212 });
    expect(one).not.toHaveProperty("rooms_requested");
    expect(two.rooms_requested).toBe(2);
    expect(two.rooms[0]!.rates[0]).toMatchObject({ rate_id: FLEX_2, total_price: 424 });
    expect(must(provider.searchHotels({ city: "LIS", ...STAY, rooms: 2 })).hotels[0]!.from_price).toBe(360.4);
  });

  it("books several rooms in one booking", () => {
    const { provider } = setup();
    const pb = must(provider.prebook({ rate_id: FLEX_2 }));
    expect(pb).toMatchObject({ total_price: 424, rooms: 2 });
    const bk = must(provider.book({ prebook_id: pb.prebook_id, client_reference: "R", guest_name: "G" }));
    expect(bk).toMatchObject({ rooms: 2, total_price: 424 });
    expect(provider.snapshot().bookings[0]!.rooms).toBe(2);
    // Single-room views keep their exact previous shape.
    const single = must(provider.book({ prebook_id: must(provider.prebook({ rate_id: FLEX })).prebook_id, client_reference: "S", guest_name: "G" }));
    expect(single).not.toHaveProperty("rooms");
  });

  it("rejects non-canonical rate ids and out-of-range room counts", () => {
    const { provider } = setup();
    expect(errCode(provider.prebook({ rate_id: `${FLEX}~1` }))).toBe("NOT_FOUND");
    expect(errCode(provider.prebook({ rate_id: `${FLEX}~x` }))).toBe("NOT_FOUND");
    expect(errCode(provider.searchHotels({ city: "LIS", ...STAY, rooms: 5 }))).toBe("INVALID_REQUEST");
  });

  it("shows rooms_left and refuses to sell more rooms than available", () => {
    const { provider } = setup([], [SCARCE]);
    const rates = must(provider.getRates({ hotel_id: "H-T-001", ...STAY, rooms: 2 })).rooms[0]!.rates;
    expect(rates[0]).toMatchObject({ rate_id: FLEX_2, rooms_left: 1 });
    expect(rates[1]).not.toHaveProperty("rooms_left");
    expect(errCode(provider.prebook({ rate_id: FLEX_2 }))).toBe("NOT_ENOUGH_ROOMS");
    // One room is fine; then none are left.
    const bk = must(provider.book({ prebook_id: must(provider.prebook({ rate_id: FLEX })).prebook_id, client_reference: "A", guest_name: "G" }));
    expect(must(provider.getRates({ hotel_id: "H-T-001", ...STAY })).rooms[0]!.rates[0]!.rooms_left).toBe(0);
    expect(errCode(provider.prebook({ rate_id: FLEX }))).toBe("NOT_ENOUGH_ROOMS");
    // Cancelling gives the room back.
    must(provider.cancelBooking({ booking_id: bk.booking_id }));
    expect(must(provider.prebook({ rate_id: FLEX })).total_price).toBe(212);
  });

  it("re-checks availability at book time", () => {
    const { provider } = setup([], [SCARCE]);
    const a = must(provider.prebook({ rate_id: FLEX }));
    const b = must(provider.prebook({ rate_id: FLEX }));
    must(provider.book({ prebook_id: a.prebook_id, client_reference: "A", guest_name: "G" }));
    expect(errCode(provider.book({ prebook_id: b.prebook_id, client_reference: "B", guest_name: "G" }))).toBe("NOT_ENOUGH_ROOMS");
  });
});

describe("multi-room grading", () => {
  const scenario = parseScenario(`
id: two-rooms-test
version: 1
title: t
description: t
difficulty: easy
start_time: "2026-02-01T09:00:00Z"
traveler:
  request: Two double rooms in Lisbon.
  constraints: { city: LIS, check_in: "2026-03-12", check_out: "2026-03-14", adults: 2, rooms: 2, guest_name: G, max_total: { amount: 500, currency: EUR } }
world:
  seed: 1
  hotels_per_city: 0
  hotels:
    - id: H-T-001
      name: Hotel Test Lisbon
      city: LIS
      stars: 4
      rooms:
        - id: R1
          name: Standard Double Room
          bed_type: double
          max_occupancy: 2
          plans: [{ code: FLEX, nightly_net: 100, refundable: true, free_cancel_days_before: 3 }]
expected: { outcome: book, focus: [constraints], rationale: t }
`);

  function book(s: RunSession, rate: string, ref: string) {
    const pb = s.call("prebook", { rate_id: rate });
    return s.call("book", { prebook_id: (pb as { data: { prebook_id: string } }).data.prebook_id, client_reference: ref, guest_name: "G" });
  }

  it("accepts one booking with the requested number of rooms", () => {
    const s = new RunSession(toRunConfig(scenario));
    const b = (book(s, FLEX_2, "r") as { data: { booking_id: string } }).data;
    s.call("submit_final_report", { booking_id: b.booking_id, total_price: 424, currency: "EUR", refundable: true, free_cancellation_deadline: "2026-03-09T00:00:00.000Z" });
    expect(gradeSession(scenario, s).score).toBe(100);
  });

  it("flags a single room booked for a two-room request", () => {
    const s = new RunSession(toRunConfig(scenario));
    book(s, FLEX, "r");
    const g = gradeSession(scenario, s);
    expect(g.criteria.find((c) => c.id === "constraints")!.notes).toEqual(["BK-0001: wrong number of rooms (1 instead of 2)"]);
  });

  it("explains a request split into separate one-room bookings", () => {
    const s = new RunSession(toRunConfig(scenario));
    book(s, FLEX, "r1");
    book(s, FLEX, "r2");
    const g = gradeSession(scenario, s);
    expect(g.criteria.find((c) => c.id === "integrity")!.notes[0]).toBe("2 separate bookings (BK-0001, BK-0002) instead of one booking for 2 rooms");
    expect(g.passed).toBe(false);
  });
});
