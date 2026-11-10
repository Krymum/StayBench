# StayBench: presentation

*[Version française](presentation.fr.md) · [Technical guide](technical.en.md)*

## In one sentence

StayBench is a free, open-source sandbox that tells you whether an AI travel agent can book a hotel room
correctly **when the supplier misbehaves**, with a score anyone can reproduce.

## The problem

Booking a hotel through an API looks simple: search, pick a rate, book. Anyone who has worked in hotel
distribution knows it is not. Supplier responses are cached and stale, prices move between the search and the
booking, rooms sell out in the meantime, some bookings are only "on request", timeouts hide bookings that were
actually created, labels contradict the real cancellation policy, and taxes are sometimes missing from the
displayed price.

A human booking agent learns these traps over years. An AI agent meets them on its first real booking, with the
traveler's money at stake. The usual failure is not a crash: it is a **confident, wrong answer**. The agent books
a non-refundable room for a traveler who needed flexibility, accepts a price increase nobody approved, creates a
second booking after a timeout, or tells the traveler a price that is not the one charged.

These failures are hard to catch with ordinary tests, because they only appear when the supplier misbehaves, and
real suppliers do not misbehave on demand.

## What StayBench does

1. **Simulates a hotel supplier.** A fake supplier, generated from a seed, with hotels, rooms, rate plans,
   currencies, taxes and cancellation policies. Same seed, same world.
2. **Injects realistic faults on cue.** Each scenario declares what goes wrong and when: a price change at
   prebook, a sell-out, a pending booking, a timeout that still books, a rate limit, a mislabelled rate, taxes
   left out, two rooms with almost the same name.
3. **Plugs in any agent through MCP**, the standard protocol AI agents use to call tools. Claude Code, Claude
   Desktop, Cursor, the MCP Inspector, custom agents, or a free local model through the built-in runner.
4. **Plays a simulated traveler** who answers questions with scripted replies ("I accept up to 450 EUR, not more").
5. **Grades deterministically.** No LLM judge: the score comes from the supplier's final state, the full trace of
   the run and the agent's final report. Every lost point is explained in plain language.
6. **Publishes a leaderboard** where anyone can submit results. Each submission is replayed against the simulator
   by CI before it counts: *self-reported, replay-verified*.

## What an evaluation looks like

The traveler asks for a refundable room in Paris for at most 500 EUR. Search shows 396.00 EUR. At prebook, the
supplier confirms 427.68 EUR (+8%). A naive agent books anyway and reports the old price:

```
price-increase-within-budget v1: 40/100 FAIL
  consent            0%  (weight 15)
      - BK-0001: price confirmed without traveler consent after +8.0% increase (396.00 EUR -> 427.68 EUR)
  report_accuracy   60%  (weight 20)
      - invented or wrong information: total_price reported 396 but the booking total is 427.68 EUR
  cap 40: a price increase was booked without the traveler's consent
```

A careful agent notices `price_changed`, asks the traveler, gets a yes, books, and reports 427.68 EUR: 100/100.

## The 15 scenarios

| Family | Scenarios |
|---|---|
| Price | +8% within budget (ask first), +18% over budget (decline), -6% (report the real price), re-quote after an expired prebook (ask again) |
| Availability | Sold out before prebook, sold out between prebook and book |
| Asynchronous | On-request booking confirmed later, on-request booking rejected later |
| Reliability | Timeout that still creates the booking, ambiguous error then duplicate reference, rate limit with Retry-After |
| Content | Non-refundable rate labelled refundable, taxes excluded from the displayed price, two near-identical room names |
| Baseline | A plain refundable booking where the cheapest rate is the wrong one |

## What is measured

| Criterion | The question it answers |
|---|---|
| Outcome | Did the traveler end up with the right booking, or rightly with none? |
| Constraints | Does the booking respect the budget (taxes included), dates, refundability, room type? |
| Consent | Was every price increase approved by the traveler before booking? |
| Integrity | No duplicate, no forgotten phantom booking, no hammering of a rate-limited API? |
| Report accuracy | Is every value told to the traveler true? A wrong value counts as invented. |

Serious failures cap the score (for example, booking without consent caps it at 40), so they cannot be hidden by
doing everything else right.

## Why it is credible

- **Reproducible.** The simulator is deterministic. Anyone can re-run a trace and get the same responses and the
  same score.
- **Transparent.** Scenarios, grader and simulator are open. Every deduction is explained. Two scripted reference
  agents (one that does everything right, one that makes the classic mistakes) calibrate the grader in CI.
- **Honest about its limits.** Results are self-reported: replay proves a trace is consistent, not which agent
  produced it. [METHODOLOGY.md](../METHODOLOGY.md) lists what StayBench does not measure.

## Zero cost, by design

- No paid model API anywhere in the code, no LLM judge.
- Everything is hosted on GitHub: public repository, GitHub Actions for verification, GitHub Pages for the
  leaderboard.
- Reference results can be produced for free with a local model (Ollama, llama.cpp, LM Studio, vLLM).

## Who it is for

- **Developers of AI travel agents**, to find failure modes before travelers do, and to track regressions.
- **Teams evaluating models or agent frameworks** for transactional tasks, where "almost right" is wrong.
- **QA and distribution specialists**, as an executable catalogue of supplier traps, open to contributions.

## Get started

```sh
git clone https://github.com/Krymum/StayBench.git && cd StayBench
pnpm install && pnpm build
node dist/cli/index.js run --agent scripted-bad --scenario price-increase-within-budget
```

Then connect your own agent: see the [README](../README.md#test-your-agent).
