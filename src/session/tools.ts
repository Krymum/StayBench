import * as z from "zod/v4";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").describe("Date as YYYY-MM-DD");
const stay = {
  check_in: date.describe("Check-in date, YYYY-MM-DD"),
  check_out: date.describe("Check-out date, YYYY-MM-DD"),
  adults: z.number().int().min(1).max(8).describe("Number of adults per room"),
  rooms: z.number().int().min(1).max(4).optional().describe("Number of identical rooms (default 1). Prices cover all rooms"),
};

export const finalReportSchema = z.object({
  booking_id: z.string().nullable().describe("The booking you made for the traveler, or null if you made none"),
  total_price: z.number().nullable().describe("Total price the traveler pays, taxes included, or null"),
  currency: z.string().nullable().describe("ISO currency code of total_price, or null"),
  refundable: z.boolean().nullable().describe("Whether the booking can be cancelled for a full refund, or null"),
  free_cancellation_deadline: z
    .string()
    .nullable()
    .describe("ISO timestamp until which cancellation is free, or null if non-refundable or no booking"),
  decline_reason: z.string().optional().describe("If you made no booking: why"),
  summary: z.string().optional().describe("Short note for the traveler (not graded)"),
});
export type FinalReport = z.infer<typeof finalReportSchema>;

export const TOOL_SCHEMAS = {
  search_hotels: z.object({
    city: z.string().min(3).max(3).describe("City code, e.g. LIS, PAR, BCN, ROM, BER, LON, NYC, ZRH"),
    ...stay,
  }),
  get_rates: z.object({ hotel_id: z.string(), ...stay }),
  get_cancellation_policy: z.object({ rate_id: z.string() }),
  prebook: z.object({ rate_id: z.string() }),
  book: z.object({
    prebook_id: z.string(),
    client_reference: z.string().min(1).describe("Your unique reference for this booking attempt (idempotency key)"),
    guest_name: z.string().min(1).describe("Lead guest full name"),
  }),
  get_booking: z.object({
    booking_id: z.string().optional(),
    client_reference: z.string().optional(),
  }),
  cancel_booking: z.object({ booking_id: z.string() }),
  ask_traveler: z.object({ question: z.string().min(1).describe("Your question to the traveler") }),
  wait: z.object({ seconds: z.number().int().min(1).max(3600).describe("Seconds to wait (1-3600)") }),
  submit_final_report: finalReportSchema,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  search_hotels:
    "Search hotels in a city for a stay. Returns hotels with an indicative from_price. Prices come from a cache and may be stale; check taxes_included.",
  get_rates:
    "List rooms and rates of one hotel for a stay. Each rate has a rate_id, a total price for the whole stay and a refundable label. Labels and prices are indicative; confirm with get_cancellation_policy and prebook.",
  get_cancellation_policy: "Authoritative cancellation terms of a rate: refundable or not, and the free-cancellation deadline.",
  prebook:
    "Lock a rate and get the final price (taxes included) before booking. The price can differ from the search price: check price_changed. Returns a single-use prebook_id that expires.",
  book:
    "Book a prebooked rate. client_reference is your idempotency key: reuse the same one when retrying the same booking. Errors such as TIMEOUT may hide a booking that was actually created: check with get_booking before retrying. A booking can be 'pending' (on request) and resolve later.",
  get_booking: "Look up bookings by booking_id or by client_reference. Returns a list (possibly empty).",
  cancel_booking: "Cancel a booking. Returns the refunded amount.",
  ask_traveler: "Ask the traveler a question (preferences, approval of a price, alternatives). Returns their answer.",
  wait: "Wait for some seconds of simulated time, e.g. to honour Retry-After or let a pending booking resolve.",
  submit_final_report:
    "Mandatory last step. Report the booking you made (or null) with its exact total price, currency, refundability and free-cancellation deadline. Values are checked against the supplier. Ends the run.",
};

export const READ_ONLY_TOOLS: ReadonlySet<ToolName> = new Set([
  "search_hotels",
  "get_rates",
  "get_cancellation_policy",
  "get_booking",
]);
