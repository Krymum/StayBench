import * as z from "zod/v4";
import { CURRENCIES } from "../core/money.js";
import { PROVIDER_TOOLS } from "../faults/types.js";
import { ERROR_CODES } from "../simulator/types.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bedType = z.enum(["single", "double", "twin", "king"]);
const currency = z.enum(CURRENCIES);
const occurrence = z.union([z.literal("first"), z.literal("always"), z.number().int().min(1)]);
const where = z.strictObject({ hotel_id: z.string().optional(), room_id: z.string().optional(), plan_id: z.string().optional() });

const hotelSpec = z.strictObject({
  id: z.string().regex(/^H-[A-Z0-9-]+$/),
  name: z.string(),
  city: z.string().length(3),
  district: z.string().optional(),
  stars: z.number().int().min(1).max(5),
  currency: currency.optional(),
  tax_percent: z.number().min(0).max(50).optional(),
  rooms: z.array(
    z.strictObject({
      id: z.string().regex(/^R[0-9A-Z]*$/),
      name: z.string(),
      bed_type: bedType,
      max_occupancy: z.number().int().min(1).max(8),
      plans: z.array(
        z.strictObject({
          code: z.string().regex(/^[A-Z0-9]+$/),
          board: z.enum(["room_only", "breakfast"]).optional(),
          nightly_net: z.number().positive(),
          refundable: z.boolean(),
          free_cancel_days_before: z.number().int().min(0).max(60).optional(),
        }),
      ).min(1),
    }),
  ).min(1),
});

const faultBase = { id: z.string().optional() };
const faultSpec = z.discriminatedUnion("type", [
  z.strictObject({ ...faultBase, type: z.literal("price_change"), where: where.optional(), percent: z.number(), occurrence: occurrence.optional() }),
  z.strictObject({ ...faultBase, type: z.literal("sold_out"), where: where.optional(), stage: z.enum(["search_to_prebook", "prebook_to_book"]), occurrence: occurrence.optional() }),
  z.strictObject({ ...faultBase, type: z.literal("on_request"), where: where.optional(), outcome: z.enum(["confirmed", "rejected"]), resolve_after_s: z.number().int().min(1), occurrence: occurrence.optional() }),
  z.strictObject({
    ...faultBase, type: z.literal("error"), on: z.enum(PROVIDER_TOOLS), where: where.optional(), code: z.enum(ERROR_CODES),
    message: z.string().optional(), booking_created: z.boolean().optional(), occurrence: occurrence.optional(),
  }),
  z.strictObject({ ...faultBase, type: z.literal("duplicate_reference"), mode: z.literal("accept") }),
  z.strictObject({ ...faultBase, type: z.literal("rate_limit"), on: z.union([z.enum(PROVIDER_TOOLS), z.literal("any")]), retry_after_s: z.number().int().min(1), occurrence: occurrence.optional() }),
  z.strictObject({ ...faultBase, type: z.literal("mislabeled_refundable"), where: where.optional(), label: z.boolean().optional() }),
  z.strictObject({ ...faultBase, type: z.literal("taxes_excluded"), where: where.optional() }),
]);

const replyRule = z.strictObject({
  intent: z.string(),
  match: z.array(z.string()).min(1),
  reply: z.string().optional(),
  consent: z
    .strictObject({
      max_total: z.number().positive().optional(),
      always: z.enum(["accept", "refuse"]).optional(),
      accept: z.string(),
      refuse: z.string(),
      no_quote: z.string().optional(),
    })
    .optional(),
});

export const CRITERIA = ["outcome", "constraints", "consent", "integrity", "report_accuracy"] as const;
export type CriterionId = (typeof CRITERIA)[number];

export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number().int().min(1),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  start_time: z.string().datetime(),
  tick_s: z.number().min(0).default(2),
  traveler: z.strictObject({
    request: z.string(),
    /** Machine-readable version of the request: used by the grader (and the scripted agents). */
    constraints: z.strictObject({
      city: z.string().length(3),
      check_in: isoDate,
      check_out: isoDate,
      adults: z.number().int().min(1),
      guest_name: z.string(),
      max_total: z.strictObject({ amount: z.number().positive(), currency }).optional(),
      refundable_required: z.boolean().default(false),
      bed_type: bedType.optional(),
      min_stars: z.number().int().min(1).max(5).optional(),
    }),
    replies: z.array(replyRule).default([]),
    default_reply: z.string().optional(),
  }),
  world: z.strictObject({
    seed: z.number().int().min(0),
    generate_cities: z.array(z.string().length(3)).optional(),
    hotels_per_city: z.number().int().min(0).max(30).optional(),
    hotels: z.array(hotelSpec).default([]),
  }),
  faults: z.array(faultSpec).default([]),
  expected: z.strictObject({
    outcome: z.enum(["book", "decline"]),
    /** Criteria this scenario is designed to exercise (catalog + tests). */
    focus: z.array(z.enum(CRITERIA)).min(1),
    /** Human explanation of the trap and the correct behaviour. */
    rationale: z.string(),
  }),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Constraints = Scenario["traveler"]["constraints"];
