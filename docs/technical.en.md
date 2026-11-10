# StayBench: technical guide

*[Version française](technical.fr.md) · [Presentation](presentation.en.md) · [Methodology](../METHODOLOGY.md)*

This guide explains how StayBench is built: architecture, data formats, the life of a run, and how to extend it.
Every design choice with a trade-off is logged in [DECISIONS.md](../DECISIONS.md).

## 1. Stack

| Concern | Choice |
|---|---|
| Language, runtime | TypeScript (strict), Node.js 22+, ESM |
| Package manager | pnpm 12 (workspace: root package + `site/`) |
| MCP | Official TypeScript SDK v2: `@modelcontextprotocol/server`, `/client`, `/node` (spec 2026-07-28) |
| Validation | Zod v4 (`zod/v4`): tool schemas, scenario schema, submission meta |
| Scenarios | YAML (`yaml` package) |
| Tests | Vitest |
| Site | Astro 7, static output |
| CI and hosting | GitHub Actions, GitHub Pages |

No runtime dependency calls a model API. The only network client is the optional OpenAI-compatible adapter,
which talks to the URL you give it.

## 2. Architecture

```
                 ┌──────────────────────── staybench (CLI) ────────────────────────┐
                 │  list   serve   grade   run   verify                             │
                 └────┬───────┬───────┬──────┬──────┬───────────────────────────────┘
                      │       │       │      │      │
  scenarios/*.yaml ──▶ scenarios/loader ──▶ RunConfig ──────────────┐
                              │                                     ▼
  MCP client ──stdio/HTTP──▶ mcp/server ──┐                 session/RunSession
  scripted agents ─────────────────────────┼──▶ call(tool,args) ──┬─▶ simulator/HotelProvider
  local model (OpenAI-compatible) ────────┘                      │      └─ faults/FaultEngine
                                                                  ├─▶ traveler/Traveler
                                                                  ├─▶ core/VirtualClock
                                                                  └─▶ trace (JSONL)
                                                                          │
                                  trace/replay ◀──────────────────────────┘
                                       │
                                  grader/grade ──▶ GradeResult ──▶ leaderboard/verify ──▶ site/
```

The key idea: **`RunSession.call(tool, args)` is the single entry point for every tool call**, whatever the
caller (MCP server, scripted agent, local model adapter, replay). It advances the clock, validates arguments,
dispatches, records the trace line. Because nothing else can change the run's state, the trace is a complete and
replayable record.

### Source layout

| Directory | Responsibility | Main exports |
|---|---|---|
| `src/core/` | Deterministic primitives | `Rng` (mulberry32 + `fork`), `VirtualClock`, money helpers (integer minor units), UTC date helpers |
| `src/simulator/` | Supplier world and behaviour | `generateWorld(spec)`, `HotelProvider`, catalog types, `ERROR_CODES` |
| `src/faults/` | Fault definitions and firing rules | `FaultSpec` union, `FaultEngine` |
| `src/traveler/` | Simulated traveler | `Traveler`, `PRICE_KEYWORDS`, `containsKeyword` |
| `src/session/` | Run session and tool contract | `RunSession`, `TOOL_SCHEMAS`, `TOOL_DESCRIPTIONS`, `finalReportSchema` |
| `src/mcp/` | MCP server and transports | `buildMcpServer`, `serveSessionStdio`, `serveSessionHttp` |
| `src/scenarios/` | Scenario schema and loading | `scenarioSchema`, `loadScenarios`, `toRunConfig`, `scenarioHash` |
| `src/trace/` | Trace format, IO, replay | `TraceLine` types, `TraceWriter`, `parseTrace`, `replayTrace` |
| `src/grader/` | Deterministic grading | `gradeSession`, `gradeTrace`, `explain`, `WEIGHTS`, `CAPS` |
| `src/agents/` | Agents and callers | `ScriptedGoodAgent`, `ScriptedBadAgent`, `OpenAICompatibleAgent`, `runAgent`, `sessionCaller`, `mcpCaller` |
| `src/leaderboard/` | Submission verification | `verifySubmission`, `buildLeaderboard`, `submissionMetaSchema` |
| `src/cli/` | Command line | `cmdList`, `cmdServe`, `cmdGrade`, `cmdRun`, `cmdVerify` |

Everything is re-exported from `src/index.ts`, so StayBench can also be used as a library.

## 3. The simulator

### World generation

`generateWorld({ seed, generate_cities?, hotels_per_city?, hotels? })` builds the catalog:

- Eight cities with a currency and a (fictional) tax rate: LIS, PAR, BCN, ROM, BER (EUR), LON (GBP), NYC (USD),
  ZRH (CHF).
- Each city draws from its own RNG stream, `rng.fork("city:<code>")`, so changing one city never reshuffles another.
- Generated hotels get 2 to 4 room types and up to three plans: `FLEX` (refundable, free cancellation 1 to 7 days
  before check-in), `NR` (non-refundable, 10 to 20% cheaper), `BB` (breakfast, refundable).
- Hand-written hotels from the scenario are added (or replace a generated hotel with the same id). Their room ids
  and plan codes are local and get prefixed: `H-LIS-101` + `R1` + `FLEX` gives plan `H-LIS-101-R1-FLEX`.

### Identifiers and prices

- **Rate id** = `<plan_id>~<check_in>~<check_out>~<adults>`, e.g. `H-LIS-101-R1-FLEX~2026-03-12~2026-03-14~2`.
  It is stay-specific and parseable, so `prebook` needs no hidden state from `get_rates`.
- **Prebook ids** `PB-0001`, **booking ids** `BK-0001`: sequential, hence deterministic.
- **Money** is stored in integer minor units. Price = nightly net × nights, taxes = round(net × tax%), total = net +
  taxes. Price changes apply to the net; taxes are recomputed. Agents see decimals with 2 places.
- **Free-cancellation deadline** = midnight UTC of the check-in date minus N days.

### Supplier behaviour

| Operation | Behaviour |
|---|---|
| `search_hotels` | Hotels of the city with at least one room fitting the occupancy; `from_price` = cheapest displayed rate |
| `get_rates` | Rooms fitting the occupancy and their rates, with the displayed price, `taxes_included` and the `refundable` label |
| `get_cancellation_policy` | The true policy of the plan |
| `prebook` | Final total with taxes, `price_changed` and `previous_price` when it differs from the displayed price; expires after 15 minutes; single-use |
| `book` | Checks, in order: rate limit, required fields, client-reference deduplication, prebook existence/use/expiry, injected errors, sell-out, on-request |
| `get_booking` | By `booking_id` or `client_reference`; returns a list |
| `cancel_booking` | Full refund until the deadline, nothing after |

Displayed prices are **stale by design**: after a price change or a sell-out found at prebook, `search_hotels` and
`get_rates` keep showing the old data, like a real supplier cache.

### Fault engine

Faults are declared in the scenario and evaluated at fixed check points inside the provider:

| Type | Check point | Effect |
|---|---|---|
| `price_change` | `prebook` | Applies `percent` to the net price. Sticky for the rate. |
| `sold_out` | `prebook` (`search_to_prebook`) or `book` (`prebook_to_book`) | `SOLD_OUT`. Sticky for the rate. |
| `on_request` | `book` | Booking created as `pending`, resolves to `outcome` after `resolve_after_s` |
| `error` | any provider tool (`on`) | Typed error `code`. With `booking_created: true` on `book`, the booking exists anyway (ghost booking) |
| `duplicate_reference` | `book` | Disables client-reference deduplication |
| `rate_limit` | every provider call (`on`, or `any`) | `RATE_LIMITED` with `retry_after_s`; calls during the window are rejected again |
| `mislabeled_refundable` | display | Overrides the `refundable` label in `get_rates` |
| `taxes_excluded` | display | Displayed prices exclude taxes, `taxes_included: false` |

`where` narrows a fault to a hotel, room or plan. `occurrence` is `first` (default), `always` or `n` (the n-th
matching call). Counting rule: a fault's counter increments once per call that reaches its check point and
matches `where`. Calls rejected earlier (rate limit, validation) do not count. Every firing is logged as a
`FaultEvent` and copied into the trace line's hidden `meta`.

## 4. The run session

`new RunSession(runConfig, { tracePath?, agent?, onEnd? })` creates the clock, the generated world, the provider
with its fault engine, and the traveler. Then, for each `call(tool, args)`:

1. If the run is finished: return `RUN_FINISHED` (not traced).
2. Advance the clock by `tick_s` (2 s by default).
3. Validate `args` with the tool's Zod schema (`UNKNOWN_TOOL` / `INVALID_ARGUMENTS` on failure, traced).
4. Dispatch to the provider, the traveler, `wait`, or the final report.
5. Collect hidden annotations: faults fired during the call, the traveler's classification and decision.
6. Append a `call` line to the trace (in memory and, when `tracePath` is set, synchronously on disk).
7. On a valid `submit_final_report`, write the `end` line and call `onEnd`.

`close()` ends a run without a report (used when an MCP client disconnects).

### Tools

| Tool | Arguments |
|---|---|
| `search_hotels` | `city`, `check_in`, `check_out`, `adults` |
| `get_rates` | `hotel_id`, `check_in`, `check_out`, `adults` |
| `get_cancellation_policy` | `rate_id` |
| `prebook` | `rate_id` |
| `book` | `prebook_id`, `client_reference`, `guest_name` |
| `get_booking` | `booking_id?`, `client_reference?` |
| `cancel_booking` | `booking_id` |
| `ask_traveler` | `question` |
| `wait` | `seconds` (1 to 3600) |
| `submit_final_report` | `booking_id`, `total_price`, `currency`, `refundable`, `free_cancellation_deadline` (all nullable), `decline_reason?`, `summary?` |

Tool results are JSON text. Success: the payload. Failure: `{"error": {"code", "message", "retry_after_s"?}}` with
`isError: true`. Error codes: `INVALID_REQUEST`, `NOT_FOUND`, `RATE_LIMITED`, `TIMEOUT`, `UPSTREAM_ERROR`,
`SOLD_OUT`, `PREBOOK_EXPIRED`, `PREBOOK_ALREADY_USED`, `DUPLICATE_CLIENT_REFERENCE`, `ALREADY_CANCELLED`, plus the
session-level `UNKNOWN_TOOL`, `INVALID_ARGUMENTS`, `RUN_FINISHED`.

### The traveler

Rules are checked in order; the first rule whose keywords match the normalized question (lowercase, accents
removed, keywords matched at word starts) answers. A rule has either a fixed `reply`, or a `consent` policy decided
on the latest successful prebook (`max_total`, or `always: accept|refuse`). `$price` expands to the shared
English/French price keyword list. The decision (`intent`, `decision`, `prebook_id`, `total`) is stored in the
hidden `meta` of the trace line; the agent only sees the answer text.

## 5. MCP server

`buildMcpServer(session)` registers the ten tools (Zod input schemas, descriptions, `readOnlyHint` /
`destructiveHint` annotations), server instructions, and a `traveler_request` prompt.

- **stdio**: `serveStdio(() => buildMcpServer(session))` from `@modelcontextprotocol/server/stdio`. Logs go to
  stderr, since stdout is the protocol channel.
- **Streamable HTTP**: `createMcpHandler(() => buildMcpServer(session))` adapted to `node:http` with `toNodeHandler`,
  bound to `127.0.0.1`, behind the SDK's Host and Origin guards, at `/mcp`.

The v2 HTTP handler is stateless (one `McpServer` per request), so every instance is bound to the same
`RunSession`: **one process = one run**. Arguments rejected by the SDK's schema validation never reach the session,
so they are not traced; they cannot change state, so replay is unaffected.

## 6. Scenarios

A scenario file `scenarios/NN-<id>.yaml` is validated by `scenarioSchema` (strict: unknown keys are errors).

```yaml
id: price-increase-within-budget      # must match the file name
version: 1                            # bump on any change
title: ...
description: ...
tags: [price-change, consent]
difficulty: easy | medium | hard
start_time: "2026-02-01T09:00:00Z"
tick_s: 2                             # optional
traveler:
  request: "Text given to the agent"
  constraints:                        # same request, machine-readable (grader + scripted agents)
    city: PAR
    check_in: "2026-03-20"
    check_out: "2026-03-22"
    adults: 2
    guest_name: Louis Martin
    max_total: { amount: 500, currency: EUR }   # optional
    refundable_required: true                   # default false
    bed_type: twin                              # optional
    min_stars: 4                                # optional
  replies:
    - intent: price_consent
      match: ["$price"]
      consent: { max_total: 500, accept: "Yes...", refuse: "No..." }
    - intent: alternative
      match: ["another hotel"]
      reply: "Any hotel that fits my request is fine."
  default_reply: "..."                # optional
world:
  seed: 202
  generate_cities: [LIS, ROM]         # never the scenario's own city
  hotels_per_city: 5
  hotels: [ ...hand-written hotels... ]
faults: [ ...see section 3... ]
expected:
  outcome: book | decline
  focus: [consent, report_accuracy]   # criteria the scenario exercises
  rationale: "The trap and the right behaviour, with amounts"
```

`toRunConfig(scenario)` derives the `RunConfig` embedded in every trace header. `scenarioHash` is the SHA-256 of the
canonical JSON of the parsed scenario (sorted keys), independent of formatting and line endings.

## 7. Trace format

JSONL, one object per line: a `header`, one `call` per tool call, and an `end` line.

```jsonc
{"type":"header","format":1,"staybench_version":"0.1.0",
 "run":{"scenario_id":"price-increase-within-budget","scenario_version":1,"scenario_hash":"431c…",
        "start_time":"2026-02-01T09:00:00Z","tick_s":2,"world":{…},"faults":[…],"traveler":{…}},
 "agent":{"name":"scripted-bad"}}
{"type":"call","seq":3,"t":"2026-02-01T09:00:06.000Z","tool":"prebook",
 "args":{"rate_id":"H-PAR-101-R1-FLEX~2026-03-20~2026-03-22~2"},
 "result":{"ok":true,"data":{"prebook_id":"PB-0001","total_price":427.68,"price_changed":true,"previous_price":396,…}},
 "meta":{"faults":[{"fault_id":"prebook-increase","type":"price_change","detail":{"percent":8,…}}]}}
{"type":"call","seq":4,"t":"2026-02-01T09:00:08.000Z","tool":"book","args":{…},"result":{"ok":true,"data":{…}}}
{"type":"end","t":"2026-02-01T09:00:10.000Z","report":{"booking_id":"BK-0001","total_price":396,…}}
```

- `t` is virtual time; wall-clock time never appears inside a trace (only in default file names).
- `meta` is ground truth hidden from the agent: fault firings and traveler decisions.
- `report` is `null` when the run ended without a final report.

### Replay

`replayTrace(trace)` builds a fresh `RunSession` from `header.run`, re-executes every call, and compares the
result, the meta and the timestamp of each line, plus the final report, using canonical JSON. Any difference is a
`ReplayMismatch`.

## 8. Grader

`gradeSession(scenario, session)` reads the provider snapshot (bookings and prebooks, with ground-truth fields such
as `created_despite_error`, `resolve_outcome`, `original_total_minor`), the trace and the report. It produces five
criterion results (score 0 to 1 or `null` when not applicable, plus notes), applies caps, and returns:

```ts
interface GradeResult {
  scenario_id: string; scenario_version: number;
  score: number;            // 0..100, one decimal
  passed: boolean;          // score >= 80
  criteria: Array<{ id; weight; score: number | null; notes: string[] }>;
  caps: Array<{ id; max; reason }>;
  mismatches: ReplayMismatch[];
  stats: { calls; bookings_created; virtual_duration_s };
}
```

`gradeTrace(scenario, trace)` first requires `canonicalJson(trace.header.run) === canonicalJson(toRunConfig(scenario))`
(otherwise it throws), then replays and grades the replayed session. A trace with mismatches scores 0.

Weights, caps and the exact rules are documented in [METHODOLOGY.md](../METHODOLOGY.md#scoring).

## 9. Agents

`Agent { name; run(call: ToolCaller, input: { request, constraints }) }`, where
`ToolCaller = (tool, args) => Promise<ToolOutcome>`.

- `sessionCaller(session)` calls the session directly; `mcpCaller(client)` goes through an MCP client and maps
  `isError` results back to outcomes. The same agent can run in-process or over a real transport.
- `runAgent(agent, scenario, opts)` creates the session (optionally with a trace file), runs the agent, closes the run.
- `ScriptedGoodAgent`: generic best-practice policy (Retry-After, policy check, budget on the prebook total,
  consent on increases, lookup by client reference after ambiguous errors, polling of pending bookings).
- `ScriptedBadAgent`: the classic mistakes, used to prove the grader catches them.
- `OpenAICompatibleAgent`: Chat Completions loop with `tools` generated from the same Zod schemas
  (`z.toJSONSchema`), `temperature: 0`, 40 turns max, 2 nudges if the model stops calling tools. Accepts tool
  arguments as a JSON string or an object (Ollama). The model gets the request text only.

## 10. CLI reference

| Command | Description |
|---|---|
| `staybench list [--json]` | Scenario catalog |
| `staybench serve --scenario <id> [--transport stdio\|http] [--port 3333] [--trace <file>]` | MCP server for one run; prints the request and, at the end, the grade |
| `staybench grade <trace.jsonl> [--json]` | Replay and grade a trace. Exit code 0 graded, 2 inconsistent, 1 error |
| `staybench run --agent <local-openai\|scripted-good\|scripted-bad> (--scenario <id> \| --all) [--base-url] [--model] [--api-key] [--max-turns 40] [--out runs] [--submitter <handle> --name "<display>"] [--json]` | Automatic runs; with `--submitter`, `--out` becomes a leaderboard submission |
| `staybench verify [results] [--out <file>] [--json] [--allow-invalid]` | Verify submissions and build the leaderboard JSON. Exit code 1 if any is invalid, unless `--allow-invalid` |

Default trace path: `runs/<scenario>/<agent>-<UTC timestamp>.jsonl`.

## 11. Leaderboard pipeline

- A submission is `results/<submitter>/<name>/meta.json` plus one trace per scenario anywhere below it.
- `verifySubmission` validates `meta.json` (`submissionMetaSchema`), then for each trace: known scenario, current
  version, single trace per scenario, `gradeTrace` without mismatch.
- Status: `verified` (complete, no error), `incomplete` (missing scenarios, counted as 0), `invalid` (any error).
- `buildLeaderboard` adds the scenario catalog and sorts entries; `pnpm site:data` writes it to
  `site/src/data/leaderboard.json` (generated, not committed); Astro renders it.

### Workflows

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | push to `main`, pull requests | install (frozen lockfile), typecheck, tests, build, strict `verify results`, site build |
| `verify-results.yml` | pull requests touching `results/` | refuses changes outside `results/`, replays and re-grades every submission, writes a job summary |
| `pages.yml` | push to `main`, manual | re-verifies with `main`'s code, builds the site with the Pages base path, deploys |

## 12. Tests

| Suite | Covers |
|---|---|
| `tests/unit/core`, `world-gen`, `provider`, `faults` | Determinism, generation, supplier rules, each fault type, occurrence and counting |
| `tests/unit/traveler`, `session` | Keyword matching, consent decisions, clock, tracing, hidden meta |
| `tests/unit/grader`, `leaderboard` | Each criterion and cap, tampering detection, submission statuses, the committed `results/` |
| `tests/unit/openai-agent` | The adapter against a deterministic fake model |
| `tests/integration/mcp` | MCP in-process, real HTTP, spawned stdio |
| `tests/scenarios` | For each scenario: good agent 100 with pinned report, bad agent fails its focus criteria, determinism and replay |
| `tests/e2e` | Scripted agent → MCP Streamable HTTP → trace → replay → grade on all scenarios; real CLI binary over stdio and HTTP |

`pnpm test` runs everything (about 170 tests, a few seconds).

## 13. Extending StayBench

- **A scenario**: see [METHODOLOGY.md](../METHODOLOGY.md#contributing-a-scenario).
- **A fault type**: add its interface to `FaultSpec` (`src/faults/types.ts`) and its Zod variant to the scenario
  schema; call `faults.fire(...)` (occurrence-based) or `faults.active(...)` (display) at the right check point in
  `HotelProvider`; add unit tests; document it in this guide and DECISIONS.md. If the grader must know about it,
  record what it needs in the provider snapshot or the fault event detail.
- **A tool**: add its Zod schema and description in `src/session/tools.ts` and its dispatch in
  `RunSession.dispatch`. The MCP server and the OpenAI-compatible adapter pick it up automatically.
- **A grading rule**: add it to the relevant criterion in `src/grader/grade.ts` with a readable note, then make sure
  `scripted-good` still scores 100 everywhere. A change of scoring is a change of methodology: document it.
- **An agent**: implement `Agent` and register it in `makeAgent` (`src/cli/commands.ts`).
