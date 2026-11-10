#!/usr/bin/env node
import { parseArgs } from "node:util";
import { STAYBENCH_VERSION } from "../version.js";
import { AGENTS, cmdGrade, cmdList, cmdRun, cmdServe, cmdVerify, defaultIo } from "./commands.js";

const HELP = `staybench ${STAYBENCH_VERSION} - test AI agents on hotel booking

Usage:
  staybench list [--json]
      List scenarios.

  staybench serve --scenario <id> [--transport stdio|http] [--port 3333] [--trace <file>]
      Start the MCP server for one run and print the traveler's request.
      stdio (default) is for MCP clients that spawn the server; http serves
      Streamable HTTP on http://127.0.0.1:<port>/mcp.

  staybench grade <trace.jsonl> [--json]
      Replay a recorded trace against the simulator and grade it.

  staybench run --agent <${AGENTS.join("|")}> (--scenario <id> | --all)
                [--base-url <url>] [--model <name>] [--api-key <key>]
                [--max-turns 40] [--out runs] [--json]
      Run an agent automatically. local-openai talks to any OpenAI-compatible
      endpoint, e.g. Ollama: --base-url http://localhost:11434/v1 --model qwen3:8b

  staybench verify [results-dir] [--out leaderboard.json] [--json] [--allow-invalid]
      Verify leaderboard submissions: replay every trace, check it matches the
      current scenario version, recompute scores. Exit code 1 if any is invalid,
      unless --allow-invalid (used to build the site: invalid entries are shown as such).

  Add --submitter <github-handle> [--name "<display name>"] to "run" to write
  the meta.json of a leaderboard submission into --out.

Common options:
  --scenarios-dir <dir>   Use scenarios from another directory.
  -h, --help              Show this help.
  -v, --version           Show the version.
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      scenario: { type: "string", short: "s" },
      all: { type: "boolean" },
      transport: { type: "string", default: "stdio" },
      port: { type: "string", default: "3333" },
      trace: { type: "string" },
      agent: { type: "string" },
      "base-url": { type: "string" },
      model: { type: "string" },
      "api-key": { type: "string" },
      "max-turns": { type: "string" },
      out: { type: "string" },
      "scenarios-dir": { type: "string" },
      submitter: { type: "string" },
      name: { type: "string" },
      "allow-invalid": { type: "boolean" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) {
    defaultIo.out(STAYBENCH_VERSION);
    return 0;
  }
  if (values.help || !command) {
    defaultIo.out(HELP);
    return values.help ? 0 : 1;
  }
  const scenariosDir = values["scenarios-dir"];

  switch (command) {
    case "list":
      return cmdList({ json: values.json, ...(scenariosDir ? { scenariosDir } : {}) });

    case "serve": {
      if (!values.scenario) throw new Error("serve requires --scenario <id>");
      const transport = values.transport;
      if (transport !== "stdio" && transport !== "http") throw new Error("--transport must be stdio or http");
      const server = await cmdServe({
        scenario: values.scenario,
        transport,
        port: Number(values.port),
        ...(values.trace ? { trace: values.trace } : {}),
        ...(scenariosDir ? { scenariosDir } : {}),
      });
      const stop = () => void server.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      // Make sure the trace gets its end line whatever happens (writes are synchronous).
      process.on("exit", () => server.session.close());
      if (transport === "stdio") process.stdin.on("end", stop);
      return new Promise<number>(() => {}); // run until stopped
    }

    case "grade": {
      const trace = rest[0] ?? values.trace;
      if (!trace) throw new Error("grade requires a trace file: staybench grade <trace.jsonl>");
      return cmdGrade({ trace, json: values.json, ...(scenariosDir ? { scenariosDir } : {}) });
    }

    case "run": {
      if (!values.agent) throw new Error(`run requires --agent <${AGENTS.join("|")}>`);
      const { code } = await cmdRun({
        agent: values.agent,
        ...(values.scenario ? { scenario: values.scenario } : {}),
        all: values.all,
        ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values["api-key"] ? { apiKey: values["api-key"] } : {}),
        ...(values["max-turns"] ? { maxTurns: Number(values["max-turns"]) } : {}),
        out: values.out ?? "runs",
        json: values.json,
        ...(values.submitter ? { submitter: values.submitter } : {}),
        ...(values.name ? { displayName: values.name } : {}),
        ...(scenariosDir ? { scenariosDir } : {}),
      });
      return code;
    }

    case "verify":
      return cmdVerify({
        results: rest[0] ?? "results",
        allowInvalid: values["allow-invalid"],
        ...(values.out ? { out: values.out } : {}),
        json: values.json,
        ...(scenariosDir ? { scenariosDir } : {}),
      });

    default:
      defaultIo.err(`Unknown command "${command}".\n`);
      defaultIo.out(HELP);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    defaultIo.err(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
