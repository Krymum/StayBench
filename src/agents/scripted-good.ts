import type { ToolOutcome } from "../trace/types.js";
import type { Agent, AgentInput, ToolCaller } from "./types.js";

/* Minimal views of tool payloads used by the scripted agents. */
export interface HotelHit { hotel_id: string; stars: number; from_price: number }
export interface RateHit { rate_id: string; total_price: number; taxes_included: boolean; refundable: boolean }
export interface RoomHit { room_id: string; name: string; bed_type: string; rates: RateHit[] }
export interface Prebook { prebook_id: string; total_price: number; currency: string; price_changed: boolean; previous_price?: number }
export interface Booking {
  booking_id: string; status: string; total_price: number; currency: string;
  refundable: boolean; free_cancellation_until: string | null;
}

const AFFIRMATIVE = /^(yes|yeah|ok|okay|sure|fine|go ahead|oui|d'accord|ok\b)/i;

/**
 * Reference agent that follows supplier best practices. It is generic (no per-scenario
 * logic): it reads the structured constraints and reacts to what the supplier returns.
 *  - honours Retry-After with wait()
 *  - checks the authoritative cancellation policy, never the label
 *  - compares the prebook total (taxes included) with the budget
 *  - asks the traveler before accepting a price increase
 *  - after an ambiguous error, looks the booking up by client_reference before retrying
 *  - polls pending bookings until they resolve
 */
export class ScriptedGoodAgent implements Agent {
  readonly name = "scripted-good";

  async run(rawCall: ToolCaller, { constraints: c }: AgentInput): Promise<void> {
    const call = async (tool: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
      for (let attempt = 0; ; attempt++) {
        const r = await rawCall(tool, args);
        if (r.ok || attempt >= 6) return r;
        if (r.error.code === "RATE_LIMITED") {
          await rawCall("wait", { seconds: r.error.retry_after_s ?? 5 });
          continue;
        }
        if (r.error.code === "UPSTREAM_ERROR" && tool !== "book" && attempt < 2) continue; // safe to retry reads
        return r;
      }
    };
    const stay = { check_in: c.check_in, check_out: c.check_out, adults: c.adults };
    const max = c.max_total?.amount ?? Number.POSITIVE_INFINITY;

    const decline = async (reason: string) => {
      await call("submit_final_report", {
        booking_id: null, total_price: null, currency: null, refundable: null,
        free_cancellation_deadline: null, decline_reason: reason,
      });
    };

    const search = await call("search_hotels", { city: c.city, ...stay });
    if (!search.ok) return decline(`Search failed: ${search.error.code}`);
    const hotels = (search.data as { hotels: HotelHit[] }).hotels.filter((h) => !c.min_stars || h.stars >= c.min_stars);

    // Collect candidate rates, with the facts that matter, cheapest displayed first.
    const candidates: Array<{ rate_id: string; displayed: number }> = [];
    for (const h of hotels) {
      const rates = await call("get_rates", { hotel_id: h.hotel_id, ...stay });
      if (!rates.ok) continue;
      for (const room of (rates.data as { rooms: RoomHit[] }).rooms) {
        if (c.bed_type && room.bed_type !== c.bed_type) continue;
        for (const rate of room.rates) {
          if (c.refundable_required) {
            const pol = await call("get_cancellation_policy", { rate_id: rate.rate_id });
            if (!pol.ok || !(pol.data as { refundable: boolean }).refundable) continue;
          }
          candidates.push({ rate_id: rate.rate_id, displayed: rate.total_price });
        }
      }
    }
    candidates.sort((a, b) => a.displayed - b.displayed);

    let refSeq = 0;
    for (const cand of candidates) {
      const booking = await this.tryBook(call, cand.rate_id, `SB-${++refSeq}`, c.guest_name, max);
      if (booking) {
        await call("submit_final_report", {
          booking_id: booking.booking_id,
          total_price: booking.total_price,
          currency: booking.currency,
          refundable: booking.refundable,
          free_cancellation_deadline: booking.free_cancellation_until,
          summary: `Booked ${booking.booking_id}.`,
        });
        return;
      }
    }
    return decline("No available option satisfies the request (budget, refundability, room type).");
  }

  /** Returns a confirmed booking for this rate, or null if the rate is not usable. */
  private async tryBook(call: ToolCaller, rateId: string, ref: string, guest: string, max: number): Promise<Booking | null> {
    for (let quote = 0; quote < 2; quote++) {
      const pbR = await call("prebook", { rate_id: rateId });
      if (!pbR.ok) return null;
      const pb = pbR.data as Prebook;
      if (pb.total_price > max + 1e-9) return null;
      if (pb.price_changed && pb.previous_price !== undefined && pb.total_price > pb.previous_price) {
        const a = await call("ask_traveler", {
          question: `The price went up from ${pb.previous_price.toFixed(2)} to ${pb.total_price.toFixed(2)} ${pb.currency} (taxes included). Do you accept this price?`,
        });
        if (!a.ok || !AFFIRMATIVE.test((a.data as { answer: string }).answer.trim())) return null;
      }

      let booking: Booking | null = null;
      for (let attempt = 0; attempt < 2 && !booking; attempt++) {
        const b = await call("book", { prebook_id: pb.prebook_id, client_reference: ref, guest_name: guest });
        if (b.ok) {
          booking = b.data as Booking;
          break;
        }
        const code = b.error.code;
        if (code === "TIMEOUT" || code === "UPSTREAM_ERROR" || code === "DUPLICATE_CLIENT_REFERENCE") {
          // The booking may exist: look it up before doing anything else.
          const found = await call("get_booking", { client_reference: ref });
          const existing = found.ok ? (found.data as { bookings: Booking[] }).bookings.find((x) => x.status !== "rejected" && x.status !== "cancelled") : undefined;
          if (existing) booking = existing;
          else if (code === "DUPLICATE_CLIENT_REFERENCE") return null;
          continue; // retry once with the same reference and prebook
        }
        if (code === "PREBOOK_EXPIRED") break; // re-quote
        return null; // SOLD_OUT and others: next candidate
      }
      if (!booking) continue;

      for (let i = 0; booking.status === "pending" && i < 30; i++) {
        await call("wait", { seconds: 60 });
        const g = await call("get_booking", { booking_id: booking.booking_id });
        if (g.ok) booking = (g.data as { bookings: Booking[] }).bookings[0] ?? booking;
      }
      return booking.status === "confirmed" ? booking : null;
    }
    return null;
  }
}
