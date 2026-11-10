import { describe, expect, it } from "vitest";
import { PREBOOK_TTL_S } from "../../src/simulator/provider.js";
import { FLEX, NR, STAY, TWIN, errCode, must, setup } from "../helpers.js";

describe("HotelProvider: catalog", () => {
  it("searches hotels by city with a tax-inclusive from_price", () => {
    const { provider } = setup();
    const res = must(provider.searchHotels({ city: "LIS", ...STAY }));
    expect(res.hotels).toEqual([
      {
        hotel_id: "H-T-001", name: "Hotel Test Lisbon", city: "LIS", district: "Baixa", stars: 4,
        from_price: 180.2, currency: "EUR", taxes_included: true, // NR: 170 net + 6% = 180.20
      },
    ]);
    expect(must(provider.searchHotels({ city: "PAR", ...STAY })).hotels).toEqual([]);
  });

  it("filters rooms by occupancy", () => {
    const { provider } = setup();
    expect(must(provider.searchHotels({ city: "LIS", ...STAY, adults: 3 })).hotels).toEqual([]);
    expect(must(provider.getRates({ hotel_id: "H-T-001", ...STAY, adults: 3 })).rooms).toEqual([]);
  });

  it("lists rates per room with stable rate ids", () => {
    const { provider } = setup();
    const rates = must(provider.getRates({ hotel_id: "H-T-001", ...STAY }));
    expect(rates.nights).toBe(2);
    expect(rates.rooms.map((r) => r.room_id)).toEqual(["H-T-001-R1", "H-T-001-R2"]);
    expect(rates.rooms[0]!.rates).toEqual([
      { rate_id: FLEX, board: "room_only", total_price: 212, currency: "EUR", taxes_included: true, refundable: true },
      { rate_id: NR, board: "room_only", total_price: 180.2, currency: "EUR", taxes_included: true, refundable: false },
    ]);
    expect(rates.rooms[1]!.rates[0]!.rate_id).toBe(TWIN);
  });

  it("returns the true cancellation policy", () => {
    const { provider } = setup();
    expect(must(provider.getCancellationPolicy({ rate_id: FLEX }))).toMatchObject({
      refundable: true,
      free_cancellation_until: "2026-03-09T00:00:00.000Z",
    });
    expect(must(provider.getCancellationPolicy({ rate_id: NR }))).toMatchObject({
      refundable: false,
      free_cancellation_until: null,
    });
  });

  it("validates inputs with typed errors", () => {
    const { provider } = setup();
    expect(errCode(provider.searchHotels({ city: "LIS", check_in: "2026-01-10", check_out: "2026-01-12", adults: 2 }))).toBe("INVALID_REQUEST");
    expect(errCode(provider.searchHotels({ city: "LIS", check_in: "2026-03-14", check_out: "2026-03-12", adults: 2 }))).toBe("INVALID_REQUEST");
    expect(errCode(provider.searchHotels({ city: "LIS", check_in: "2026-3-14", check_out: "2026-03-16", adults: 2 }))).toBe("INVALID_REQUEST");
    expect(errCode(provider.searchHotels({ city: "LIS", ...STAY, adults: 0 }))).toBe("INVALID_REQUEST");
    expect(errCode(provider.getRates({ hotel_id: "H-NOPE", ...STAY }))).toBe("NOT_FOUND");
    expect(errCode(provider.prebook({ rate_id: "garbage" }))).toBe("NOT_FOUND");
    expect(errCode(provider.prebook({ rate_id: "H-T-001-R1-FLEX~2026-03-12~2026-03-14~5" }))).toBe("NOT_FOUND");
  });
});

describe("HotelProvider: booking flow", () => {
  it("prebooks and books at the quoted price", () => {
    const { provider } = setup();
    const pb = must(provider.prebook({ rate_id: FLEX }));
    expect(pb).toMatchObject({ prebook_id: "PB-0001", total_price: 212, taxes: 12, price_changed: false });
    expect(pb).not.toHaveProperty("previous_price");
    const bk = must(provider.book({ prebook_id: pb.prebook_id, client_reference: "REF-1", guest_name: "Ana Silva" }));
    expect(bk).toMatchObject({
      booking_id: "BK-0001", status: "confirmed", total_price: 212, currency: "EUR",
      refundable: true, free_cancellation_until: "2026-03-09T00:00:00.000Z", room_name: "Standard Double Room",
    });
  });

  it("prebooks are single-use and expire", () => {
    const { provider, clock } = setup();
    const pb = must(provider.prebook({ rate_id: FLEX }));
    must(provider.book({ prebook_id: pb.prebook_id, client_reference: "A", guest_name: "G" }));
    expect(errCode(provider.book({ prebook_id: pb.prebook_id, client_reference: "B", guest_name: "G" }))).toBe("PREBOOK_ALREADY_USED");

    const pb2 = must(provider.prebook({ rate_id: TWIN }));
    clock.advance(PREBOOK_TTL_S + 1);
    expect(errCode(provider.book({ prebook_id: pb2.prebook_id, client_reference: "C", guest_name: "G" }))).toBe("PREBOOK_EXPIRED");
    expect(errCode(provider.book({ prebook_id: "PB-9999", client_reference: "D", guest_name: "G" }))).toBe("NOT_FOUND");
  });

  it("requires client_reference and guest_name", () => {
    const { provider } = setup();
    const pb = must(provider.prebook({ rate_id: FLEX }));
    expect(errCode(provider.book({ prebook_id: pb.prebook_id, client_reference: " ", guest_name: "G" }))).toBe("INVALID_REQUEST");
    expect(errCode(provider.book({ prebook_id: pb.prebook_id, client_reference: "R", guest_name: "" }))).toBe("INVALID_REQUEST");
  });

  it("rejects a reused client reference by default (idempotency)", () => {
    const { provider } = setup();
    must(provider.book({ prebook_id: must(provider.prebook({ rate_id: FLEX })).prebook_id, client_reference: "SAME", guest_name: "G" }));
    const second = provider.book({ prebook_id: must(provider.prebook({ rate_id: TWIN })).prebook_id, client_reference: "SAME", guest_name: "G" });
    expect(errCode(second)).toBe("DUPLICATE_CLIENT_REFERENCE");
    expect(provider.snapshot().bookings).toHaveLength(1);
  });

  it("finds bookings by id or client reference", () => {
    const { provider } = setup();
    const bk = must(provider.book({ prebook_id: must(provider.prebook({ rate_id: FLEX })).prebook_id, client_reference: "R1", guest_name: "G" }));
    expect(must(provider.getBooking({ booking_id: bk.booking_id })).bookings).toHaveLength(1);
    expect(must(provider.getBooking({ client_reference: "R1" })).bookings[0]!.booking_id).toBe(bk.booking_id);
    expect(must(provider.getBooking({ client_reference: "unknown" })).bookings).toEqual([]);
    expect(errCode(provider.getBooking({ booking_id: "BK-9999" }))).toBe("NOT_FOUND");
    expect(errCode(provider.getBooking({}))).toBe("INVALID_REQUEST");
  });

  it("refunds in full before the free-cancellation deadline, nothing after", () => {
    const { provider, clock } = setup();
    const a = must(provider.book({ prebook_id: must(provider.prebook({ rate_id: FLEX })).prebook_id, client_reference: "A", guest_name: "G" }));
    const b = must(provider.book({ prebook_id: must(provider.prebook({ rate_id: NR })).prebook_id, client_reference: "B", guest_name: "G" }));
    expect(must(provider.cancelBooking({ booking_id: a.booking_id })).refund_amount).toBe(212);
    expect(must(provider.cancelBooking({ booking_id: b.booking_id })).refund_amount).toBe(0);
    expect(errCode(provider.cancelBooking({ booking_id: a.booking_id }))).toBe("ALREADY_CANCELLED");

    const c = must(provider.book({ prebook_id: must(provider.prebook({ rate_id: TWIN })).prebook_id, client_reference: "C", guest_name: "G" }));
    clock.advance(40 * 86400); // past 2026-03-11 deadline
    expect(must(provider.cancelBooking({ booking_id: c.booking_id })).refund_amount).toBe(0);
    expect(must(provider.getBooking({ booking_id: c.booking_id })).bookings[0]!.status).toBe("cancelled");
  });

  it("snapshot exposes ground truth without leaking mutable state", () => {
    const { provider } = setup();
    must(provider.book({ prebook_id: must(provider.prebook({ rate_id: FLEX })).prebook_id, client_reference: "A", guest_name: "G" }));
    const snap = provider.snapshot();
    snap.bookings[0]!.status = "cancelled";
    expect(provider.snapshot().bookings[0]!.status).toBe("confirmed");
    expect(snap.prebooks[0]).toMatchObject({ original_total_minor: 21200, total_minor: 21200, used: true });
  });
});
