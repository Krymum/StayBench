# Design decisions

Choices made where the spec was ambiguous. The rule: pick the simplest option, write it down here.

## Time and determinism

- **Virtual clock only.** The simulator never reads wall-clock time. Time advances by a fixed tick per tool
  call (set in the session layer) and through an explicit `wait(seconds)` tool. Without `wait`, an agent could
  not honour `Retry-After` or let an on-request booking resolve without hammering the API.
- **Seeded PRNG (mulberry32)** with per-city forked streams: adding or changing one city never reshuffles
  another. `Math.random()` is never used in the simulator.
- **Sequential ids** (`PB-0001`, `BK-0001`) instead of random ones: deterministic and easy to read in traces.

## Catalog and money

- **Money in integer minor units** internally, exposed to agents as decimals with 2 places. Only 2-decimal
  currencies are supported (EUR, GBP, USD, CHF).
- **Price = per room, for the whole stay.** Occupancy only filters rooms (`max_occupancy`); it does not change
  the price.
- **Taxes** are a per-hotel percentage of the net price. Displayed prices include taxes unless the
  `taxes_excluded` fault is active, in which case `taxes_included: false` is shown and prebook reveals the total.
- **Rate ids are stay-specific and parseable**: `<plan_id>~<check_in>~<check_out>~<adults>`. No hidden server
  state is needed between `get_rates` and `prebook`, which keeps replay simple. An agent could build one by
  hand; that is harmless.
- **Cancellation deadlines** are midnight UTC of the check-in date minus N days. Hotel time zones are ignored.
- **`get_cancellation_policy` is the source of truth** for refundability. The `refundable` label in `get_rates`
  can lie (`mislabeled_refundable` fault). The grader always compares against the true policy.

## Provider behaviour

- **Stale cache by design.** After a price change or a sell-out at prebook, `search_hotels` and `get_rates`
  keep showing the old data, as real cached supplier content does. Faults are **sticky** per rate id: once a
  price changed or a rate sold out, re-prebooking does not undo it.
- **Prebooks are single-use** and expire after 15 virtual minutes.
- **Client references are deduplicated by default** (`DUPLICATE_CLIENT_REFERENCE`), and this check runs before
  any other book validation, as on most real suppliers. The `duplicate_reference` fault (mode `accept`) turns
  deduplication off: re-sending a reference then silently creates a second booking.
- **Ghost bookings** are modelled as an `error` fault on `book` with `booking_created: true` (e.g. `TIMEOUT` or
  `UPSTREAM_ERROR`): the agent gets an error but the booking exists and consumes the prebook.
- **Fault counting rule**: a fault's occurrence counter increments once per call that reaches its check point
  and matches its `where`. Calls rejected earlier (rate limit, validation) are not counted. Calls made during an
  open rate-limit window are rejected again and logged, but do not count towards new windows.
- **Price changes apply to the net price**; taxes are recomputed on the new net.

## Consent and traveler

- **Consent detection** in `ask_traveler` uses deterministic keyword matching (English and French) on the
  free-text question. Simple and reproducible; an oddly-worded question may not be recognised. Documented as a
  limitation in METHODOLOGY.md.
- **Price decreases do not require consent.** The final report must still reflect the new, lower price.

## MCP server

- **SDK v2** (`@modelcontextprotocol/server`, `/client`, `/node`, spec 2026-07-28) rather than the v1 `@modelcontextprotocol/sdk`
  package, which is now the maintenance line. Tool schemas use Zod v4 (`zod/v4`), as in the official docs.
- **One process = one run.** The v2 Streamable HTTP handler is stateless (a fresh `McpServer` per request), so
  every server instance is bound to the same `RunSession`, which holds all run state. stdio uses the same factory.
- **HTTP binds to 127.0.0.1** with the SDK's Host/Origin guards, at `/mcp`.
- **Tool results are JSON text.** Success: the payload as JSON. Failure: `{"error": {code, message, retry_after_s?}}`
  with `isError: true`. No `outputSchema` (it would add a second contract to keep in sync).
- **Arguments rejected by the MCP schema never reach the session**, so they are not traced and do not advance the
  clock. They cannot change state, so replay is unaffected. Non-MCP callers (scripted agents, replay) get the same
  validation inside the session as `INVALID_ARGUMENTS`, which is traced.
- **Calls after `submit_final_report`** return `RUN_FINISHED` and are not traced: the end line closes the trace.
- **Tick: 2 virtual seconds per call** by default (scenario-configurable).
- **`traveler_request` MCP prompt** exposes the traveler's request, so MCP clients that surface prompts (e.g. as
  slash commands) can start a run without copy-paste.

## Traveler

- **Consent decisions are based on the latest successful prebook**, not on numbers parsed from the question:
  the traveler "looks at" the price the agent actually obtained. This avoids fragile number parsing (dates,
  per-night vs total). If no prebook exists yet, the traveler asks for a confirmed price first.
- **`$price` keyword macro** expands to a shared English/French list of price/confirmation keywords.
- The full run config (world, faults, traveler) is embedded in the trace header, so a trace is replayable on its own.

## Scenarios

- **The scenario city contains only hand-written hotels.** Generated hotels fill other cities (realism, and the seed
  still matters), but never the city being searched. Otherwise a generated hotel could silently make a "decline"
  scenario bookable or let an agent sidestep the trap.
- **Acceptability is rule-based**: a booking is acceptable iff it satisfies the structured `constraints` (city, dates,
  occupancy, budget taxes included, refundability per the true policy, bed type, minimum stars). No list of "right
  answers" to maintain; `expected.outcome` only says whether booking was possible at all.
- **`expected.focus`** names the criteria a scenario is designed to exercise; tests check the naive agent fails them.
- **Scenario hash** = sha256 of the canonical JSON of the parsed scenario, independent of key order and line endings.
- **Keyword matching starts at a word boundary** (`rate` does not match `separate`).

## Grader

- Weights: outcome 35, constraints 15, consent 15, integrity 15, report accuracy 20. A criterion that does not apply
  (e.g. consent when no price increase was booked) is excluded and the remaining weights are renormalised.
- **Caps** make serious failures fail regardless of the rest: constraint violation 40, booking a price increase
  without consent 40, duplicate active bookings 40, no booking when one was possible 30, no report 50, any wrong
  value in the report 60. Pass threshold: 80.
- **Consent** is valid only if an `ask_traveler` call classified as `price_consent` was answered "accept" after the
  increased prebook and before the book call, for a total at least equal to the booked total.
- **Pending at the end of the run** counts as half an outcome if the hotel would have confirmed, zero if it would have
  rejected (the ground truth knows).
- **Integrity deductions**: phantom booking created despite an error and never looked up (-0.5), cancelled booking
  (-0.25, or -0.5 with a penalty), each call made during a Retry-After window (-0.1, max -0.5).
- **Traces are always graded by replay.** The trace header must equal the run config derived from the scenario (no
  edited faults); any response that differs from the simulator's makes the trace inconsistent and scores 0.

## Scripted agents

- They receive the **structured constraints** in addition to the request text, because they cannot read natural
  language. LLM agents only get the text. The good agent is generic (no per-scenario branches) and doubles as a
  reference implementation of supplier best practices.
- The good agent recognises the traveler's approval with a simple affirmative pattern ("yes", "ok", "oui"...).

## CLI

- **`node:util` parseArgs**, no CLI framework dependency.
- **Traces** default to `runs/<scenario>/<agent>-<UTC timestamp>.jsonl` (git-ignored). Wall-clock time only appears in
  the file name, never inside the trace, so traces stay reproducible.
- **`serve` logs to stderr** (stdout is the MCP channel in stdio mode). It prints the traveler's request, the
  endpoint, and the grade as soon as the final report is submitted. The trace end line is written on exit even if
  the agent never reports.
- **`grade` exit codes**: 0 graded, 2 trace inconsistent with the simulator, 1 error.
- **`run`** accepts `local-openai`, `scripted-good` and `scripted-bad`. Scripted agents make `run` a zero-setup demo.
- **esbuild's install script is denied** (`allowBuilds: esbuild: false` in pnpm-workspace.yaml): tsx works without it,
  and pnpm 12 refuses to install while the choice is pending.

## Local model adapter

- **Generic OpenAI-compatible Chat Completions client** (`POST {base-url}/chat/completions` with `tools`), so it works
  with Ollama, llama.cpp server, LM Studio or vLLM. There is no default URL and no provider SDK: the project never
  calls a paid API by itself.
- Tool definitions are generated from the same Zod schemas as the MCP server (`z.toJSONSchema`), so the two cannot
  drift.
- `temperature: 0`, at most 40 model turns, 2 nudges when the model answers without a tool call, then the run ends
  without a report (graded as such). Tool-call arguments are accepted as a JSON string or an object (Ollama).
- The adapter talks to the session in-process (same `RunSession` as MCP), so traces are identical in format.

## Leaderboard

- **Submission layout**: `results/<submitter>/<name>/meta.json` plus one trace per scenario anywhere below it
  (`staybench run --all --out results/<you>/<name> --submitter <you>` produces exactly that).
- **Ranking score** = average over *all* current scenarios; a missing scenario counts as 0. Status: `verified`
  (all scenarios, no error), `incomplete` (missing scenarios), `invalid` (any error: replay mismatch, altered run
  config, outdated scenario version, duplicate trace, bad meta.json). Ranked: verified, then incomplete, then invalid.
- **Two verification points.** The PR workflow replays every trace and refuses PRs that touch anything outside
  `results/`. Because a PR's workflow runs the PR's own code, the authoritative check is the second one: the Pages
  build re-verifies every submission with the code on `main` and shows failures as `invalid`.
- **Leaderboard data is generated, not committed** (`site/src/data/leaderboard.json` is built by `pnpm site:data`).
- **Reference submissions** of the two scripted agents are committed under `results/staybench/` so the board is not
  empty and the replay pipeline is exercised by CI on every push.
- **Site**: Astro, static output, no client-side JavaScript, system fonts, light/dark via `prefers-color-scheme`.
  Base path `/StayBench` (overridable with `BASE_PATH`/`SITE_URL`; the Pages workflow passes the values from
  `actions/configure-pages`).
- **Outdated traces are not migrated**: a scenario version bump invalidates older traces for that scenario.

## 0.2.0: findings from the first real agent run

- **Agents are told the simulated date.** A Claude Code run on `timeout-ghost-booking` declined because it knew the
  real date (2026-11-10) and judged a June 2026 stay to be in the past, while the simulator lives on 2026-02-01. The
  request given to agents now starts with `Today's date: <scenario start date>.` and the MCP server instructions and
  the local-model system prompt repeat it. Scenarios are unchanged.
- **Price consent is no longer triggered by generic words.** "Please confirm the dates" was classified as a price
  question because `$price` contained "confirm". The list now holds money words only, plus any amount with two
  decimals; "confirm", "proceed", "accept", "approve", "go ahead" and their French equivalents were removed.
- **Built-in `dates` rule**, checked after the scenario's rules: questions about the stay dates get "The dates in my
  request are the ones I need".
- **Traces replay only on the same StayBench major.minor.** These changes alter traveler answers, so 0.1 traces would
  no longer replay. `verify` reports "recorded with StayBench X, current is Y; re-run it" instead of an opaque replay
  mismatch. Behaviour-changing releases bump the minor version; patch releases keep behaviour identical.
- **The consent rule is stated to the agent.** In 0.2.0, Claude Code booked +8% and +5% increases that stayed within
  budget without asking, and said so to the traveler: a defensible reading of "I can spend up to 500 EUR", penalised
  by a rule the agent could not know. Scenarios 02 and 12 (v2) now say "If the price changes, check with me before
  booking." The trap stays: the agent must notice `price_changed` and honour the instruction. Trade-off: the sentence
  hints that a price change may happen in those two scenarios (see METHODOLOGY limits).

## 0.2.1: six new scenarios (16-21)

- New traps: last-minute stay whose refundable rate can no longer be cancelled for free, minimum star rating,
  breakfast required, price jump over budget with an alternative hotel, ghost booking whose lookup is rate-limited,
  everything sold out.
- **New `board` constraint** (`room_only` | `breakfast`), checked by the grader against the booked plan.
- **Refundability means free cancellation is still possible.** With `refundable_required`, a booking whose
  free-cancellation deadline is not after the booking time violates the constraints, even if the policy flag says
  refundable. No existing scenario is affected (all deadlines are in the future).
- A patch release: the simulator's responses are unchanged, so 0.2.0 traces still replay. Existing submissions
  become `incomplete` until they add the six new scenarios.
- **Multi-room bookings** (scenarios 22-23): `search_hotels` and `get_rates` take an optional `rooms` (identical
  rooms; `adults` is per room). Prices cover all rooms. A plan may declare `available_rooms`; `get_rates` then shows
  `rooms_left` and `prebook`/`book` fail with `NOT_ENOUGH_ROOMS` when too few are left. All rooms must be in one
  booking: several bookings that together cover the request are reported as split, not as valid.
- **Backward compatible on purpose**: a rate id only gets a `~<rooms>` suffix for 2+ rooms, and the new fields
  (`rooms`, `rooms_left`, `rooms_requested`) only appear when they apply, so every earlier response is unchanged and
  0.2.0 traces still replay. `rooms` is optional in the scenario schema (absent = 1) so existing scenario hashes do
  not change.

## 0.2.2: harder scenarios (24-29)

- Claude Code reached 23/23, so new scenarios target judgement and combinations rather than single signals: an
  unstated bed type (the agent must ask), relative dates, a three-hour on-request refusal, cancellation terms changed
  at prebook, a city tax paid at the hotel within an all-in budget, and five failures chained in one run.
- **New fault `policy_change`** (prebook): the rate becomes non-refundable for good; prebook returns
  `policy_changed: true`, `refundable: false`, `free_cancellation_until: null`, and the policy endpoint and the
  booking reflect it. The signal is explicit, like `price_changed`: the test is whether the agent reads it.
- **Fees paid at the hotel** (`pay_at_property_per_night` on a plan): shown at prebook and on the booking as
  `pay_at_property`, excluded from `total_price` (what the supplier charges, compared by the report check), included
  in the budget check.
- The reference agent now waits up to 4 simulated hours for an on-request answer (5-minute polls) and cancels a still
  pending booking before trying another hotel. Cancelling instead of waiting costs 0.25 integrity and still passes.
- In `slow-on-request` the duplicate trap targets agents that rebook while a booking is pending; the naive agent never
  rebooks, so the scenario's `focus` is `outcome` only.
- Still a patch release: new fields only appear in the new situations, earlier traces replay unchanged.
