/**
 * Simulated traveler. Answers `ask_traveler` questions with replies scripted by the scenario.
 * Fully deterministic: keyword matching on the normalized question, first matching rule wins.
 */

export interface ConsentPolicy {
  /** Accept if the latest prebook total (incl. taxes) is at or below this amount, in the prebook currency. */
  max_total?: number;
  /** Fixed decision regardless of price. */
  always?: "accept" | "refuse";
}

export interface ReplyRule {
  /** Free label used by the grader, e.g. "price_consent", "alternative", "bed_type". */
  intent: string;
  /** Keywords (any language). A rule matches when the normalized question contains any of them. */
  match: string[];
  /** Fixed reply. Mutually exclusive with `consent`. */
  reply?: string;
  /** Decision-based reply, evaluated against the latest prebook. */
  consent?: ConsentPolicy & { accept: string; refuse: string; no_quote?: string };
}

export interface TravelerSpec {
  /** Text given to the agent at the start of the run. */
  request: string;
  replies?: ReplyRule[];
  default_reply?: string;
}

/** What the traveler knows about the run at the time of the question. */
export interface TravelerContext {
  latestPrebook?: { prebook_id: string; total: number; currency: string };
}

export interface TravelerAnswer {
  answer: string;
  /** Hidden from the agent; recorded in the trace for the grader. */
  meta: {
    intent: string | null;
    decision?: "accept" | "refuse";
    prebook_id?: string;
    total?: number;
    currency?: string;
  };
}

export const DEFAULT_REPLY = "I don't have a preference on that. Please use your judgement within my request.";

/**
 * Keywords that signal a question about price or confirmation, in English and French.
 * Scenarios can use this list for their consent rule (`match: ["$price"]`).
 */
export const PRICE_KEYWORDS = [
  "price", "cost", "total", "amount", "budget", "increase", "higher", "more expensive", "rate", "charge",
  "confirm", "proceed", "accept", "approve", "okay with", "ok with", "go ahead",
  "prix", "cout", "montant", "hausse", "augment", "plus cher", "tarif", "confirmer", "accepte", "valider",
  "eur", "gbp", "usd", "chf", "€", "£", "$",
];

/** Lowercase, strip accents, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keywords match at the start of a word ("augment" matches "augmenté", "rate" does not
 * match "separate"). Keywords starting with a symbol ("€") match anywhere.
 */
export function containsKeyword(normalizedText: string, keyword: string): boolean {
  if (keyword.length === 0) return false;
  if (!/^[a-z0-9]/.test(keyword)) return normalizedText.includes(keyword);
  let from = 0;
  for (;;) {
    const i = normalizedText.indexOf(keyword, from);
    if (i < 0) return false;
    if (i === 0 || !/[a-z0-9]/.test(normalizedText[i - 1]!)) return true;
    from = i + 1;
  }
}

function expandKeywords(match: string[]): string[] {
  return match.flatMap((k) => (k === "$price" ? PRICE_KEYWORDS : [k])).map(normalize);
}

export class Traveler {
  private readonly rules: Array<ReplyRule & { keywords: string[] }>;

  constructor(readonly spec: TravelerSpec) {
    this.rules = (spec.replies ?? []).map((r) => {
      if ((r.reply === undefined) === (r.consent === undefined)) {
        throw new Error(`Traveler rule "${r.intent}": exactly one of reply or consent is required`);
      }
      return { ...r, keywords: expandKeywords(r.match) };
    });
  }

  get request(): string {
    return this.spec.request;
  }

  answer(question: string, ctx: TravelerContext): TravelerAnswer {
    const q = normalize(question);
    const rule = this.rules.find((r) => r.keywords.some((k) => containsKeyword(q, k)));
    if (!rule) return { answer: this.spec.default_reply ?? DEFAULT_REPLY, meta: { intent: null } };
    if (rule.reply !== undefined) return { answer: rule.reply, meta: { intent: rule.intent } };

    const c = rule.consent!;
    const pb = ctx.latestPrebook;
    if (!c.always && !pb) {
      return {
        answer: c.no_quote ?? "Please get me a confirmed price first, then ask me.",
        meta: { intent: rule.intent },
      };
    }
    let decision: "accept" | "refuse";
    if (c.always) decision = c.always;
    else decision = c.max_total === undefined || pb!.total <= c.max_total + 1e-9 ? "accept" : "refuse";
    return {
      answer: decision === "accept" ? c.accept : c.refuse,
      meta: {
        intent: rule.intent,
        decision,
        ...(pb ? { prebook_id: pb.prebook_id, total: pb.total, currency: pb.currency } : {}),
      },
    };
  }
}
