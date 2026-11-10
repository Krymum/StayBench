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
