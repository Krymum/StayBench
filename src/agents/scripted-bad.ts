import type { Booking, HotelHit, Prebook, RoomHit } from "./scripted-good.js";
import type { Agent, AgentInput, ToolCaller } from "./types.js";

/**
 * Deliberately naive agent, used to prove the grader catches common mistakes:
 *  - trusts search prices and labels (no policy check, ignores taxes_included)
 *  - ignores bed type, budget and price changes; never asks the traveler
 *  - retries failures immediately, with a fresh prebook and a fresh client reference
 *  - never polls pending bookings
 *  - reports the price it saw in search, claims the booking is refundable, invents no deadline
 */
export class ScriptedBadAgent implements Agent {
  readonly name = "scripted-bad";

  async run(call: ToolCaller, { constraints: c }: AgentInput): Promise<void> {
    const stay = { check_in: c.check_in, check_out: c.check_out, adults: c.adults };
    let seen = { rate_id: "", price: 0, currency: "" };

    for (let attempt = 0; attempt < 3 && !seen.rate_id; attempt++) {
      const s = await call("search_hotels", { city: c.city, ...stay });
      if (!s.ok) continue;
      const hotels = [...(s.data as { hotels: HotelHit[] }).hotels].sort((a, b) => a.from_price - b.from_price);
      const cheapest = hotels[0];
      if (!cheapest) break;
      const r = await call("get_rates", { hotel_id: cheapest.hotel_id, ...stay });
      if (!r.ok) continue;
      const rates = (r.data as { currency: string; rooms: RoomHit[] }).rooms.flatMap((room) => room.rates);
      rates.sort((a, b) => a.total_price - b.total_price);
      if (rates[0]) seen = { rate_id: rates[0].rate_id, price: rates[0].total_price, currency: (r.data as { currency: string }).currency };
    }

    let booking: Booking | null = null;
    for (let attempt = 1; attempt <= 3 && seen.rate_id && !booking; attempt++) {
      const pb = await call("prebook", { rate_id: seen.rate_id });
      if (!pb.ok) continue;
      const b = await call("book", {
        prebook_id: (pb.data as Prebook).prebook_id,
        client_reference: `bad-${attempt}`,
        guest_name: c.guest_name,
      });
      if (b.ok) booking = b.data as Booking;
    }

    await call("submit_final_report", {
      booking_id: booking?.booking_id ?? null,
      total_price: seen.price || null,
      currency: seen.currency || null,
      refundable: true,
      free_cancellation_deadline: null,
    });
  }
}
