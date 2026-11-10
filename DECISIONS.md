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
