import { describe, expect, it } from "vitest";
import { DATE_REPLY, DEFAULT_REPLY, Traveler, normalize } from "../../src/traveler/traveler.js";

const traveler = new Traveler({
  request: "Find me a room.",
  replies: [
    { intent: "price_consent", match: ["$price"], consent: { max_total: 450, accept: "OK.", refuse: "Too expensive." } },
    { intent: "alternative", match: ["another hotel", "autre hôtel"], reply: "Any 3-star hotel is fine." },
  ],
  default_reply: "No preference.",
});

const quote = { latestPrebook: { prebook_id: "PB-0001", total: 449.99, currency: "EUR" } };

describe("Traveler", () => {
  it("normalizes case and accents", () => {
    expect(normalize("  Le PRIX a  Augmenté ")).toBe("le prix a augmente");
  });

  it("answers price questions from the latest prebook total", () => {
    expect(traveler.answer("The price went up, is that OK?", quote)).toEqual({
      answer: "OK.",
      meta: { intent: "price_consent", decision: "accept", prebook_id: "PB-0001", total: 449.99, currency: "EUR" },
    });
    const pricey = { latestPrebook: { ...quote.latestPrebook, total: 450.01 } };
    expect(traveler.answer("Le prix a augmenté, je confirme ?", pricey).meta.decision).toBe("refuse");
  });

  it("asks for a quote when no prebook exists yet", () => {
    const a = traveler.answer("What is your max price?", {});
    expect(a.meta).toEqual({ intent: "price_consent" });
    expect(a.answer).toMatch(/price first/);
  });

  it("uses fixed replies and the first matching rule", () => {
    expect(traveler.answer("Shall I look at an autre hôtel?", quote)).toEqual({
      answer: "Any 3-star hotel is fine.",
      meta: { intent: "alternative" },
    });
    // "price" matches first even if "another hotel" also appears
    expect(traveler.answer("Another hotel has a better price?", quote).meta.intent).toBe("price_consent");
  });

  it("matches amounts with decimals as price questions, not generic confirmation words", () => {
    expect(traveler.answer("Shall I proceed at 449.99?", quote).meta.intent).toBe("price_consent");
    expect(traveler.answer("On part sur 449,99 ?", quote).meta.intent).toBe("price_consent");
    expect(traveler.answer("Please confirm the room type", quote).meta.intent).toBeNull();
  });

  it("answers date questions with the built-in rule, after the scenario's rules", () => {
    const a = traveler.answer("Your dates are in the past. Did you mean next year? Please confirm.", quote);
    expect(a).toEqual({ answer: DATE_REPLY, meta: { intent: "dates" } });
    expect(traveler.answer("Quelle date d'arrivée ?", quote).meta.intent).toBe("dates");
    // A price question that mentions dates is still a price question.
    expect(traveler.answer("For your dates the total is 449.99 EUR, OK?", quote).meta.intent).toBe("price_consent");
  });

  it("falls back to the default reply", () => {
    expect(traveler.answer("Do you like museums?", quote)).toEqual({ answer: "No preference.", meta: { intent: null } });
    expect(new Traveler({ request: "x" }).answer("hello", {}).answer).toBe(DEFAULT_REPLY);
  });

  it("supports fixed decisions", () => {
    const t = new Traveler({ request: "x", replies: [{ intent: "price_consent", match: ["price"], consent: { always: "refuse", accept: "y", refuse: "n" } }] });
    expect(t.answer("price ok?", {}).meta.decision).toBe("refuse");
  });

  it("rejects ambiguous rules", () => {
    expect(() => new Traveler({ request: "x", replies: [{ intent: "a", match: ["a"] }] })).toThrow(/exactly one/);
  });
});
