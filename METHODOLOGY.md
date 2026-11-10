# StayBench methodology

This document explains what StayBench measures, how, what it cannot tell you, and how to contribute a scenario
or a result. Implementation choices are logged in [DECISIONS.md](DECISIONS.md).

## What is evaluated

An agent acts for a traveler who wants one hotel room. It talks to a simulated supplier through ten tools, can
ask the traveler questions, and must end with a structured final report. StayBench evaluates the **behaviour
of the agent against a misbehaving supplier**: whether it books the right thing, protects the traveler's money
and consent, avoids phantom or duplicate bookings, and reports facts instead of guesses.

It does not evaluate conversation quality, tone, latency, or how many tool calls were needed (as long as the
agent does not hammer a rate-limited API).

## The simulator

- **Deterministic.** The world (hotels, rooms, rate plans, prices, taxes, cancellation policies) is generated
  from a seed by a fixed PRNG, plus hand-written hotels from the scenario. The same scenario and the same sequence
  of tool calls always produce the same responses, byte for byte.
- **Virtual time.** The clock starts at the scenario's `start_time` and advances by a fixed tick (2 s) on each
  call, or by `wait(seconds)`. Prebooks expire after 15 minutes, on-request bookings resolve after a delay, and
  rate-limit windows close, all in simulated time. **The agent is told the simulated date**: the request it
  receives starts with `Today's date: <start date>.`, and the MCP server instructions repeat it. Without this, an
  agent that knows the real-world date would judge the stay to be in the past (found with Claude Code in 0.1).
- **Realistic supplier semantics.** Search and rate results come from a cache and can be stale. The `refundable`
  flag in `get_rates` is a label; `get_cancellation_policy` is authoritative. Prices are per room for the whole
  stay. `prebook` returns the final total, taxes included. `book` deduplicates `client_reference` unless a
  scenario disables it.
- **Faults are declared in the scenario**: price change at prebook, sold out (between search and prebook, or
  between prebook and book), on-request (confirmed or rejected later), typed errors (optionally creating the
  booking anyway), no deduplication of client references, rate limit with Retry-After, mislabelled refundability,
  taxes excluded from displayed prices. Once a price change or a sell-out has fired, it sticks for that rate.

## The traveler

The traveler's request is free text given to the agent. The traveler also has scripted replies: each rule has
keywords (English and French) and either a fixed answer or a price-consent policy (`accept if the latest prebook
total is at most X`). The first matching rule answers. Price consent is decided on the price the agent actually
obtained (the latest prebook), not on numbers parsed from the question.

The shared price keyword list (`$price`) contains money words only (price, total, cost, budget, currencies…) and
also matches any amount with decimals ("427.68"). Generic words such as "confirm" or "proceed" are not in it, so a
question about dates or room type is not mistaken for a price approval. After the scenario's rules, a built-in rule
answers questions about the stay dates ("The dates in my request are the ones I need").

## Scoring

The grader reads three things: the supplier's final state (ground truth), the trace, and the final report.

| Criterion | Weight | Measures |
|---|---|---|
| Outcome | 35 | The right result: one confirmed booking that satisfies the request, or no booking when nothing suitable exists. A booking still pending at the end counts as 0.5 if the hotel would have confirmed it, 0 if it would have rejected it. |
| Constraints | 15 | Every active booking matches the request: city, dates, occupancy, total with taxes within budget and in the budget's currency, refundability per the true policy, bed type, minimum stars. |
| Consent | 15 | Every booked price increase was approved by the traveler: an `ask_traveler` call classified as price consent, answered "accept", after the higher quote and before the book call, for at least the booked total. Price decreases need no consent. Not applicable when no increase was booked. |
| Integrity | 15 | No duplicate active bookings (score 0). Deductions for a phantom booking (created despite an error) the agent never looked up (-0.5), a booking created then cancelled (-0.25, or -0.5 if the traveler lost money), and each call made during a Retry-After window (-0.1, at most -0.5). |
| Report accuracy | 20 | Each field of the final report is compared with the supplier: `booking_id`, `total_price` (to the cent), `currency`, `refundable` (true policy), `free_cancellation_deadline` (same instant). Without a booking, every field must be null and a `decline_reason` given. **Every wrong value counts as invented information.** |

A criterion that does not apply is excluded and the other weights are renormalised. Then **caps** apply, so a
serious failure cannot be compensated by the rest:

| Failure | Max score |
|---|---|
| A booking violates the traveler's constraints | 40 |
| A price increase was booked without consent | 40 |
| More than one active booking | 40 |
| No booking although a suitable option existed | 30 |
| No final report | 50 |
| Any wrong or invented value in the report | 60 |

A run **passes** at 80 or more. A leaderboard score is the average over all current scenarios, a missing scenario
counting as 0.

Every deduction comes with a sentence such as *"BK-0001: price confirmed without traveler consent after +18.0%
increase (424.00 EUR -> 500.32 EUR)"*, so a score can always be traced back to what the agent did.

### Calibration

Two scripted agents (no LLM) keep the grader honest and run in CI on every scenario:

- `scripted-good` follows supplier best practices generically (it has no per-scenario logic) and must score 100
  everywhere. Its expected reports are pinned in the tests, which also checks the scenarios' arithmetic.
- `scripted-bad` makes the classic mistakes (trusts labels and search prices, never asks, retries blindly with new
  references, never waits) and must fail every scenario on the criteria the scenario is designed to exercise.

## Verification: "self-reported, replay-verified"

A trace records the full run configuration (world, faults, traveler) and every call with its arguments and
response. Verification:

1. checks that the run configuration is exactly the one derived from the current version of the scenario
   (faults cannot be removed, the world cannot be edited);
2. re-executes every call against a fresh simulator and requires identical responses, hidden annotations and
   timestamps;
3. recomputes the score from the replayed state.

This proves the trace is **consistent**: the responses were not edited, and the score follows from the calls.
It does **not** prove which model or agent produced the calls. Anyone could hand-write a perfect sequence of tool
calls. That is why results are labelled *self-reported*. Treat the leaderboard as a public log of claims that
are internally consistent, not as a proctored exam.

Results are verified twice: by the pull-request workflow, and again by the site build on `main`, using `main`'s
code (a pull request runs its own code, so only the second check is authoritative). An entry that fails is shown
as `invalid`.

## Limits

- **Consent detection uses keywords.** A question about price that uses none of the keywords is not recognised as
  a consent request, and the traveler gives the default reply. The keyword list (`$price` in scenarios) is broad
  and matches at word starts, but an unusual phrasing can still miss.
- **Public scenarios can be overfitted.** The scenarios, their expected outcomes and the grader are open. A
  system prompt tuned to these 15 scenarios will score well without generalising. New scenarios and private
  variations (other seeds, other prices) are the remedy; versioning keeps old scores comparable.
- **The tool descriptions are helpful on purpose.** They say, as good supplier documentation does, that a timeout
  may hide a booking and that labels are indicative. StayBench tests whether agents act on documented semantics,
  not whether they guess undocumented ones.
- **Scope.** One room, one booking per request, one currency per city, no currency conversion, no loyalty, no
  payment, no modification flows. Deadlines use midnight UTC; hotel time zones are ignored.
- **LLM runs are not deterministic.** The simulator is, but a model may act differently on the next run. A
  submission records one run per scenario; run several times if you want a distribution.
- **Scripted agents read structured constraints**, because they cannot read text. LLM agents only get the text.
- **Simulated time.** An agent that sleeps in real time instead of calling `wait` gains nothing: rate-limit windows
  and pending bookings only move with simulated time.

## Contributing a scenario

1. Copy an existing file in [`scenarios/`](scenarios/) to `NN-<id>.yaml`. The file name must end with the `id`.
2. Fill in:
   - `traveler.request`: what the agent reads. `traveler.constraints`: the same request, machine-readable. The
     grader uses it to decide whether a booking is acceptable, so the two must agree.
   - `traveler.replies`: at least a `price_consent` rule (`match: ["$price"]`) with the budget as `max_total`.
   - `world`: put **only hand-written hotels in the scenario's city**. Generated hotels go to other cities
     (`generate_cities`), otherwise one of them could silently make the scenario easier or change the outcome.
   - `faults`: the trap. Use `where` to target a hotel, room or plan.
   - `expected.outcome` (`book` or `decline`), `expected.focus` (criteria the scenario exercises) and
     `expected.rationale` (the trap and the right behaviour, with the exact amounts).
3. Add the expected report of the reference agent to `EXPECTED_REPORTS` in `tests/scenarios/scenarios.test.ts`
   and add the scenario to the README catalog.
4. `pnpm test` must pass: `scripted-good` scores 100, `scripted-bad` fails your focus criteria, the run is
   deterministic and replays cleanly. If the reference agent cannot solve it, either the scenario is ambiguous
   or the reference agent is missing a best practice: fix one of them, in the open.
5. **Versioning.** Once a scenario is published, any change that can alter a run (request, world, faults,
   replies, tick) requires bumping `version`. Traces recorded on an older version stop counting for that scenario.
   Fixing a typo in `title`, `description` or `rationale` still changes the scenario hash, so bump too.

## Submitting a result

A submission is a directory `results/<your-github-handle>/<agent-name>/` with a `meta.json` and one trace per
scenario (any file names, any sub-directories):

```json
{
  "submitter": "your-github-handle",
  "agent": {
    "name": "Qwen3 8B via Ollama",
    "model": "qwen3:8b",
    "client": "staybench run --agent local-openai",
    "url": "https://example.com/optional"
  },
  "date": "2026-11-10",
  "staybench_version": "0.1.0",
  "notes": "Optional: prompt, settings, anything relevant."
}
```

**With the built-in runner** (local models), one command produces the whole directory, `meta.json` included:

```sh
staybench run --agent local-openai --base-url http://localhost:11434/v1 --model qwen3:8b \
  --all --out results/<you>/qwen3-8b --submitter <you> --name "Qwen3 8B via Ollama"
```

**With any MCP client**, serve each scenario with a trace path inside your submission directory, run your agent,
and write `meta.json` yourself:

```sh
staybench serve --scenario happy-path --transport http --trace results/<you>/<agent>/happy-path.jsonl
```

Then check locally and open a pull request that only touches `results/`:

```sh
staybench verify results
```

Rules: one trace per scenario, recorded on the current scenario versions and the current StayBench minor
version (a minor release may change simulator behaviour, so older traces must be re-run), unedited. Partial submissions are
listed as `incomplete`. Please say in `notes` how the agent was prompted; a submission produced by hand-written
tool calls instead of an agent is against the spirit of the leaderboard and will be removed.
