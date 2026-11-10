# StayBench

**An open-source sandbox to test AI agents on hotel booking.** Your agent connects over MCP to a simulated hotel
supplier, plays realistic scenarios with injected faults, and gets a deterministic score. No LLM judge, no paid
API, no account.

The faults come from real multi-supplier hotel distribution: the price changes at prebook, the room sells out
between two calls, the booking is "on request", the supplier times out *but creates the booking anyway*, a
non-refundable rate is labelled refundable, taxes are missing from the displayed price, two rooms have almost
the same name. A good booking agent must handle all of them without inventing anything.

- 15 versioned scenarios, deterministic world generated from a seed
- MCP server (stdio and Streamable HTTP) with 10 tools, built on the official TypeScript SDK v2
- Deterministic grader with per-criterion scores and readable explanations
- Full JSONL trace of every run, replayable and re-gradable by anyone
- Leaderboard where results are **self-reported, replay-verified** by CI
  ([site](https://krymum.github.io/StayBench/))

Documentation: presentation ([English](docs/presentation.en.md) · [Français](docs/presentation.fr.md)),
technical guide ([English](docs/technical.en.md) · [Français](docs/technical.fr.md)),
[methodology](METHODOLOGY.md), [design decisions](DECISIONS.md).

## Quick start (under 5 minutes)

Requirements: Node.js 22+ and pnpm (`npm i -g pnpm`).

```sh
git clone https://github.com/Krymum/StayBench.git
cd StayBench
pnpm install
pnpm build

# See the scenarios
node dist/cli/index.js list

# Watch the reference agent solve one, and the naive one fail it
node dist/cli/index.js run --agent scripted-good --scenario price-increase-within-budget
node dist/cli/index.js run --agent scripted-bad  --scenario price-increase-within-budget
```

The second run prints something like:

```
price-increase-within-budget v1: 40/100 FAIL
  consent            0%  (weight 15)
      - BK-0001: price confirmed without traveler consent after +8.0% increase (396.00 EUR -> 427.68 EUR)
  report_accuracy   60%  (weight 20)
      - invented or wrong information: total_price reported 396 but the booking total is 427.68 EUR
  cap 40: a price increase was booked without the traveler's consent
```

The examples below write `staybench` for short: run them as `node dist/cli/index.js <command>` from the
repository, or define a shell alias (`alias staybench="node $PWD/dist/cli/index.js"`).

## Test your agent

Start a run. The server prints the traveler's request (on stderr) and records a trace:

```sh
staybench serve --scenario timeout-ghost-booking --transport http
# MCP endpoint (Streamable HTTP): http://127.0.0.1:3333/mcp
```

Give the request to your agent, let it work, and make sure it ends with `submit_final_report`. The grade is
printed as soon as the report arrives. Re-grade any trace later with `staybench grade runs/<scenario>/<file>.jsonl`.

### With Claude Code

Register the HTTP endpoint once, then restart `staybench serve` with a different `--scenario` for each run:

```sh
claude mcp add --transport http staybench http://127.0.0.1:3333/mcp
```

In Claude Code, the traveler's request is available as the MCP prompt `traveler_request`. You can also paste the
text printed by `serve`. Over stdio instead (one registration per scenario):

```sh
claude mcp add staybench -- node /absolute/path/to/StayBench/dist/cli/index.js serve --scenario happy-path
```

### With another MCP client

Most desktop clients (Claude Desktop, Cursor, and others) accept the common `mcpServers` JSON configuration
for stdio servers:

```json
{
  "mcpServers": {
    "staybench": {
      "command": "node",
      "args": ["/absolute/path/to/StayBench/dist/cli/index.js", "serve", "--scenario", "happy-path"]
    }
  }
}
```

To poke at the tools by hand, use the official MCP Inspector:

```sh
npx @modelcontextprotocol/inspector node dist/cli/index.js serve --scenario happy-path
```

Use `node dist/...` (not `pnpm staybench`) for stdio: stdout is the MCP channel and must stay clean.

### With a local model (free)

Any OpenAI-compatible endpoint works: Ollama, llama.cpp server, LM Studio, vLLM.

```sh
ollama pull qwen3:8b
staybench run --agent local-openai --base-url http://localhost:11434/v1 --model qwen3:8b --all
```

The model only receives the traveler's request and the tools, exactly like an MCP agent.

## Tools exposed to the agent

| Tool | Purpose |
|---|---|
| `search_hotels` | Hotels in a city for a stay, with an indicative (possibly stale) `from_price` |
| `get_rates` | Rooms and rates of a hotel, with a `refundable` *label* and `taxes_included` |
| `get_cancellation_policy` | Authoritative cancellation terms of a rate |
| `prebook` | Lock a rate and get the final price; `price_changed` tells if it moved |
| `book` | Book a prebook with your `client_reference` (idempotency key) |
| `get_booking` | Look up bookings by id or by client reference |
| `cancel_booking` | Cancel a booking, returns the refunded amount |
| `ask_traveler` | Ask the simulated traveler (scripted, deterministic answers) |
| `wait` | Let simulated time pass (Retry-After, pending bookings) |
| `submit_final_report` | Mandatory last step: booking id, total, currency, refundability, free-cancellation deadline |

Time is simulated: nothing ever sleeps, and the same calls always produce the same responses.

## Scenario catalog

| # | Scenario | Difficulty | What goes wrong | The agent must |
|---|---|---|---|---|
| 01 | `happy-path` | easy | Nothing; the cheapest rate is non-refundable | Book the refundable rate and report it exactly |
| 02 | `price-increase-within-budget` | easy | +8% at prebook | Ask the traveler before booking |
| 03 | `price-increase-over-budget` | medium | +18% at prebook, other options unsuitable | Book nothing and explain why |
| 04 | `price-decrease` | easy | -6% at prebook | Report the price actually booked |
| 05 | `soldout-search-to-prebook` | easy | Cheapest hotel sold out at prebook | Switch to an available hotel |
| 06 | `soldout-prebook-to-book` | medium | Room sells out at book | Recover with another hotel |
| 07 | `on-request-confirmed` | medium | Booking is pending, confirmed after 5 min | Wait and check before reporting |
| 08 | `on-request-rejected` | hard | Booking is pending, rejected after 10 min | Detect the rejection and rebook |
| 09 | `timeout-ghost-booking` | hard | Book times out but the booking exists; no deduplication | Look it up, never retry blindly |
| 10 | `duplicate-reference` | hard | Ambiguous error, then `DUPLICATE_CLIENT_REFERENCE` | Find the existing booking, no duplicate |
| 11 | `rate-limit-429` | medium | Two 429 responses with Retry-After | Wait instead of hammering |
| 12 | `prebook-expired-requote` | hard | `PREBOOK_EXPIRED`, re-quote is 5% higher | Re-prebook and ask about the new price |
| 13 | `mislabeled-nonrefundable` | medium | Non-refundable rate labelled refundable | Trust the policy, not the label |
| 14 | `taxes-excluded-budget` | medium | Displayed price excludes taxes | Apply the budget to the total with taxes |
| 15 | `near-identical-rooms` | medium | Two rooms with near-identical names | Pick the room with the right bed type |

Details and expected outcomes: [`scenarios/`](scenarios/) and the [site](https://krymum.github.io/StayBench/scenarios/).

## How scoring works

Five criteria, computed from the supplier's final state, the trace and the final report: **outcome** (35),
**constraints** (15), **consent** (15), **integrity** (15), **report accuracy** (20). Serious failures cap the
score: booking over budget or with the wrong refundability (40), booking a price increase without consent (40),
duplicate bookings (40), no booking when one was possible (30), no report (50), any wrong value in the report (60).
A run passes at 80. See [METHODOLOGY.md](METHODOLOGY.md) for the details and the limits.

## Leaderboard

Run all scenarios, then open a pull request with your traces:

```sh
staybench run --agent local-openai --base-url http://localhost:11434/v1 --model qwen3:8b \
  --all --out results/<your-github-handle>/qwen3-8b --submitter <your-github-handle>
staybench verify results
```

CI replays each trace against the simulator and recomputes the score. Agents driven through an MCP client can
submit too: see [METHODOLOGY.md](METHODOLOGY.md#submitting-a-result).

## Development

```sh
pnpm test          # unit, scenario, end-to-end and CLI tests
pnpm typecheck
pnpm site:dev      # leaderboard site on http://localhost:4321/StayBench/
```

```
src/
  core/        seeded RNG, virtual clock, money, dates
  simulator/   world generator and in-memory hotel supplier
  faults/      fault engine
  traveler/    simulated traveler
  session/     run session (single entry point for every tool call) and tool schemas
  mcp/         MCP server, stdio and Streamable HTTP
  scenarios/   scenario schema and loader
  grader/      deterministic grader
  trace/       JSONL traces and replay
  agents/      scripted agents and the OpenAI-compatible adapter
  leaderboard/ submission verification
  cli/         the staybench command
scenarios/     the 15 YAML scenarios
results/       leaderboard submissions
site/          Astro leaderboard site
```

Design choices are logged in [DECISIONS.md](DECISIONS.md).

## License

MIT
