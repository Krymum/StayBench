import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../src/core/clock.js";
import { FaultEngine, matchesWhere } from "../../src/faults/engine.js";
import type { FaultSpec } from "../../src/faults/types.js";
import { FLEX, NR, START, STAY, TWIN, errCode, must, setup } from "../helpers.js";

const R1 = { room_id: "H-T-001-R1" };

function bookRate(provider: ReturnType<typeof setup>["provider"], rate_id: string, ref: string) {
  const pb = provider.prebook({ rate_id });
  if (!pb.ok) return pb;
  return provider.book({ prebook_id: pb.data.prebook_id, client_reference: ref, guest_name: "Ana Silva" });
}

describe("FaultEngine primitives", () => {
  it("matches where clauses field by field", () => {
    expect(matchesWhere(undefined, {})).toBe(true);
    expect(matchesWhere({ hotel_id: "H1" }, { hotel_id: "H1", room_id: "R" })).toBe(true);
    expect(matchesWhere({ hotel_id: "H1", room_id: "X" }, { hotel_id: "H1", room_id: "R" })).toBe(false);
  });

  it("honours occurrence: first, nth and always", () => {
    const clock = new VirtualClock(START);
    const specs: FaultSpec[] = [
      { id: "first", type: "error", on: "search_hotels", code: "UPSTREAM_ERROR", occurrence: "first" },
      { id: "third", type: "error", on: "get_rates", code: "UPSTREAM_ERROR", occurrence: 3 },
      { id: "always", type: "error", on: "get_booking", code: "UPSTREAM_ERROR", occurrence: "always" },
    ];
    const e = new FaultEngine(specs, clock);
    const fires = (tool: "search_hotels" | "get_rates" | "get_booking") =>
      [1, 2, 3, 4].map(() => e.fire("error", tool, {}, (f) => f.on === tool)?.id ?? null);
    expect(fires("search_hotels")).toEqual(["first", null, null, null]);
    expect(fires("get_rates")).toEqual([null, null, "third", null]);
    expect(fires("get_booking")).toEqual(["always", "always", "always", "always"]);
    expect(e.events).toHaveLength(1 + 1 + 4);
  });

  it("rejects duplicate fault ids", () => {
    const f: FaultSpec = { id: "x", type: "taxes_excluded" };
    expect(() => new FaultEngine([f, f], new VirtualClock(START))).toThrow(/duplicate/);
  });
});

describe("price_change", () => {
  it("raises the price at prebook and stays sticky; get_rates stays stale", () => {
    const { provider } = setup([{ type: "price_change", where: R1, percent: 18 }]);
    const pb = must(provider.prebook({ rate_id: FLEX }));
    // 200 net * 1.18 = 236 net, + 6% tax = 250.16
    expect(pb).toMatchObject({ total_price: 250.16, previous_price: 212, price_changed: true });
    const again = must(provider.prebook({ rate_id: FLEX }));
    expect(again).toMatchObject({ total_price: 250.16, price_changed: true });
    const shown = must(provider.getRates({ hotel_id: "H-T-001", ...STAY })).rooms[0]!.rates[0]!;
    expect(shown.total_price).toBe(212);
    // Other rooms untouched
    expect(must(provider.prebook({ rate_id: TWIN })).price_changed).toBe(false);
    expect(provider.faults.events).toMatchObject([{ type: "price_change", tool: "prebook", detail: { percent: 18, rate_id: FLEX } }]);
  });

  it("supports price drops and books at the new price", () => {
    const { provider } = setup([{ type: "price_change", where: { plan_id: "H-T-001-R1-FLEX" }, percent: -6 }]);
    const bk = must(bookRate(provider, FLEX, "R"));
    expect(bk.total_price).toBe(199.28); // 188 net + 11.28 tax
  });
});

describe("sold_out", () => {
  it("search_to_prebook: prebook fails and the rate stays sold out", () => {
    const { provider } = setup([{ type: "sold_out", stage: "search_to_prebook", where: R1 }]);
    expect(errCode(provider.prebook({ rate_id: FLEX }))).toBe("SOLD_OUT");
    expect(errCode(provider.prebook({ rate_id: FLEX }))).toBe("SOLD_OUT");
    // First match only: the NR rate of the same room was not the first matching call
    expect(must(provider.prebook({ rate_id: NR })).total_price).toBe(180.2);
    // Search results stay stale on purpose
    expect(must(provider.getRates({ hotel_id: "H-T-001", ...STAY })).rooms[0]!.rates).toHaveLength(2);
  });

  it("prebook_to_book: prebook succeeds, book fails, no booking is created", () => {
    const { provider } = setup([{ type: "sold_out", stage: "prebook_to_book", where: R1 }]);
    const pb = must(provider.prebook({ rate_id: FLEX }));
    expect(errCode(provider.book({ prebook_id: pb.prebook_id, client_reference: "R", guest_name: "G" }))).toBe("SOLD_OUT");
    expect(errCode(provider.prebook({ rate_id: FLEX }))).toBe("SOLD_OUT");
    expect(provider.snapshot().bookings).toEqual([]);
    expect(must(bookRate(provider, TWIN, "R2")).status).toBe("confirmed");
  });
});

describe("on_request", () => {
  it("stays pending until resolve_after_s, then confirms", () => {
    const { provider, clock } = setup([{ type: "on_request", outcome: "confirmed", resolve_after_s: 120 }]);
    const bk = must(bookRate(provider, FLEX, "R"));
    expect(bk.status).toBe("pending");
    clock.advance(119);
    expect(must(provider.getBooking({ booking_id: bk.booking_id })).bookings[0]!.status).toBe("pending");
    clock.advance(1);
    expect(must(provider.getBooking({ booking_id: bk.booking_id })).bookings[0]!.status).toBe("confirmed");
  });

  it("can resolve to rejected", () => {
    const { provider, clock } = setup([{ type: "on_request", outcome: "rejected", resolve_after_s: 60 }]);
    const bk = must(bookRate(provider, FLEX, "R"));
    clock.advance(60);
    expect(provider.snapshot().bookings[0]!.status).toBe("rejected");
    expect(errCode(provider.cancelBooking({ booking_id: bk.booking_id }))).toBe("INVALID_REQUEST");
  });
});

describe("error faults", () => {
  it("timeout with booking_created leaves a ghost booking", () => {
    const { provider } = setup([{ type: "error", on: "book", code: "TIMEOUT", booking_created: true }]);
    const res = bookRate(provider, FLEX, "REF-1");
    expect(errCode(res)).toBe("TIMEOUT");
    const ghost = provider.snapshot().bookings;
    expect(ghost).toHaveLength(1);
    expect(ghost[0]).toMatchObject({ status: "confirmed", created_despite_error: "TIMEOUT", client_reference: "REF-1" });
    // The agent can find it by client reference
    expect(must(provider.getBooking({ client_reference: "REF-1" })).bookings).toHaveLength(1);
  });

  it("timeout without booking_created creates nothing and keeps the prebook usable", () => {
    const { provider } = setup([{ type: "error", on: "book", code: "TIMEOUT" }]);
    const pb = must(provider.prebook({ rate_id: FLEX }));
    expect(errCode(provider.book({ prebook_id: pb.prebook_id, client_reference: "R", guest_name: "G" }))).toBe("TIMEOUT");
    expect(provider.snapshot().bookings).toEqual([]);
    expect(must(provider.book({ prebook_id: pb.prebook_id, client_reference: "R", guest_name: "G" })).status).toBe("confirmed");
  });

  it("retrying after a ghost booking with the same reference is rejected by default", () => {
    const { provider } = setup([{ type: "error", on: "book", code: "UPSTREAM_ERROR", booking_created: true }]);
    expect(errCode(bookRate(provider, FLEX, "REF-1"))).toBe("UPSTREAM_ERROR");
    expect(errCode(bookRate(provider, FLEX, "REF-1"))).toBe("DUPLICATE_CLIENT_REFERENCE");
    // A fresh reference creates a real duplicate: that is the trap the grader catches
    expect(must(bookRate(provider, FLEX, "REF-2")).status).toBe("confirmed");
    expect(provider.snapshot().bookings).toHaveLength(2);
  });

  it("injected PREBOOK_EXPIRED invalidates the prebook", () => {
    const { provider } = setup([{ type: "error", on: "book", code: "PREBOOK_EXPIRED" }]);
    const pb = must(provider.prebook({ rate_id: FLEX }));
    expect(errCode(provider.book({ prebook_id: pb.prebook_id, client_reference: "R", guest_name: "G" }))).toBe("PREBOOK_EXPIRED");
    expect(errCode(provider.book({ prebook_id: pb.prebook_id, client_reference: "R", guest_name: "G" }))).toBe("PREBOOK_ALREADY_USED");
    expect(must(bookRate(provider, FLEX, "R")).status).toBe("confirmed");
  });

  it("can target any provider tool", () => {
    const { provider } = setup([{ type: "error", on: "search_hotels", code: "UPSTREAM_ERROR" }]);
    expect(errCode(provider.searchHotels({ city: "LIS", ...STAY }))).toBe("UPSTREAM_ERROR");
    expect(must(provider.searchHotels({ city: "LIS", ...STAY })).hotels).toHaveLength(1);
  });
});

describe("duplicate_reference", () => {
  it("accept mode: the provider silently creates a second booking", () => {
    const { provider } = setup([{ type: "duplicate_reference", mode: "accept" }]);
    must(bookRate(provider, FLEX, "SAME"));
    must(bookRate(provider, FLEX, "SAME"));
    expect(must(provider.getBooking({ client_reference: "SAME" })).bookings).toHaveLength(2);
  });
});

describe("rate_limit", () => {
  it("returns 429 with Retry-After and rejects calls during the window", () => {
    const { provider, clock } = setup([{ type: "rate_limit", on: "get_rates", occurrence: 2, retry_after_s: 10 }]);
    const q = { hotel_id: "H-T-001", ...STAY };
    must(provider.getRates(q));
    const limited = provider.getRates(q);
    expect(limited).toEqual({ ok: false, error: { code: "RATE_LIMITED", message: expect.any(String), retry_after_s: 10 } });
    clock.advance(4);
    const again = provider.getRates(q);
    expect(again.ok ? null : again.error.retry_after_s).toBe(6);
    // Other tools are not affected
    must(provider.searchHotels({ city: "LIS", ...STAY }));
    clock.advance(6);
    must(provider.getRates(q));
    expect(provider.faults.events.map((e) => e.detail?.during_window)).toEqual([false, true]);
  });

  it("on: any applies to every provider tool", () => {
    const { provider } = setup([{ type: "rate_limit", on: "any", occurrence: "first", retry_after_s: 5 }]);
    expect(errCode(provider.searchHotels({ city: "LIS", ...STAY }))).toBe("RATE_LIMITED");
    expect(errCode(provider.prebook({ rate_id: FLEX }))).toBe("RATE_LIMITED");
  });
});

describe("display faults", () => {
  it("mislabeled_refundable: get_rates lies, the policy and the booking tell the truth", () => {
    const { provider } = setup([{ type: "mislabeled_refundable", where: { plan_id: "H-T-001-R1-NR" } }]);
    const nr = must(provider.getRates({ hotel_id: "H-T-001", ...STAY })).rooms[0]!.rates[1]!;
    expect(nr).toMatchObject({ rate_id: NR, refundable: true });
    expect(must(provider.getCancellationPolicy({ rate_id: NR })).refundable).toBe(false);
    expect(must(bookRate(provider, NR, "R")).refundable).toBe(false);
  });

  it("taxes_excluded: displayed prices are net, prebook reveals the total", () => {
    const { provider } = setup([{ type: "taxes_excluded", where: { hotel_id: "H-T-001" } }]);
    expect(must(provider.searchHotels({ city: "LIS", ...STAY })).hotels[0]).toMatchObject({ from_price: 170, taxes_included: false });
    const flex = must(provider.getRates({ hotel_id: "H-T-001", ...STAY })).rooms[0]!.rates[0]!;
    expect(flex).toMatchObject({ total_price: 200, taxes_included: false });
    const pb = must(provider.prebook({ rate_id: FLEX }));
    expect(pb).toMatchObject({ total_price: 212, taxes: 12, taxes_included: true, price_changed: false });
  });
});

describe("determinism", () => {
  it("same world, faults and call sequence give identical responses", () => {
    const faults: FaultSpec[] = [
      { type: "price_change", where: R1, percent: 12 },
      { type: "rate_limit", on: "any", occurrence: 3, retry_after_s: 2 },
      { type: "on_request", outcome: "confirmed", resolve_after_s: 30 },
    ];
    const run = () => {
      const { provider, clock } = setup(faults);
      const out: unknown[] = [];
      for (let i = 0; i < 4; i++) {
        out.push(provider.searchHotels({ city: "LIS", ...STAY }));
        out.push(provider.getRates({ hotel_id: "H-T-001", ...STAY }));
        out.push(bookRate(provider, FLEX, `R${i}`));
        clock.advance(15);
      }
      out.push(provider.snapshot(), provider.faults.events);
      return JSON.stringify(out);
    };
    expect(run()).toBe(run());
  });
});
