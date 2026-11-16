import { spawn, type ChildProcessByStdio, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSessionHttp } from "../mcp/server.js";
import { toRunConfig } from "../scenarios/loader.js";
import type { Scenario } from "../scenarios/schema.js";
import { RunSession, type SessionOptions } from "../session/session.js";

/** Prompt put before the traveler's request. Same wording as the published Claude Code run. */
export const CLAUDE_CODE_PROMPT =
  "You are a hotel booking agent acting for a traveler. You can only act through the staybench tools. " +
  "When you are done, call submit_final_report.\n\nThe traveler's request:\n";

/**
 * Built-in tools blocked during a run: the agent only gets the StayBench tools, and cannot read
 * the scenario files or the web.
 */
export const CLAUDE_CODE_BLOCKED_TOOLS = [
  "Bash", "PowerShell", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Agent", "Task", "TodoWrite",
];

export interface ClaudeCodeOptions {
  /** Executable to run (default "claude", or $STAYBENCH_CLAUDE_BIN). */
  command?: string;
  /** Arguments put before the Claude Code ones (e.g. a script path when command is node). */
  commandArgs?: string[];
  model?: string;
  maxTurns?: number;
  /** Kills the run after this long (default 15 min). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export const DEFAULT_CLAUDE_MAX_TURNS = 80;

/**
 * Runs Claude Code headless (`claude -p`) on one scenario: serves the session over Streamable HTTP
 * on a free local port, points a fresh Claude Code session at it, waits for it to exit.
 */
export async function runClaudeCode(scenario: Scenario, opts: ClaudeCodeOptions & SessionOptions = {}): Promise<RunSession> {
  const { command = process.env.STAYBENCH_CLAUDE_BIN ?? "claude", commandArgs = [], model, maxTurns = DEFAULT_CLAUDE_MAX_TURNS, timeoutMs = 15 * 60_000, log = () => {} } = opts;
  const session = new RunSession(toRunConfig(scenario), {
    ...(opts.tracePath ? { tracePath: opts.tracePath } : {}),
    agent: { name: "claude-code", transport: "http", ...(model ? { model } : {}), ...opts.agent },
  });
  const http = await serveSessionHttp(session, { port: 0 });
  // Runs outside the repository so that no project file (scenarios, CLAUDE.md) is visible.
  const work = mkdtempSync(join(tmpdir(), "staybench-claude-"));
  try {
    writeFileSync(join(work, "mcp.json"), JSON.stringify({ mcpServers: { staybench: { type: "http", url: http.url } } }));
    const args = [
      ...commandArgs,
      "-p",
      "--mcp-config", "mcp.json",
      "--strict-mcp-config",
      "--allowedTools", "mcp__staybench",
      "--disallowedTools", CLAUDE_CODE_BLOCKED_TOOLS.join(","),
      "--max-turns", String(maxTurns),
      ...(model ? ["--model", model] : []),
    ];
    await runProcess(command, args, work, CLAUDE_CODE_PROMPT + session.request, timeoutMs, log);
  } finally {
    await http.close();
    session.close();
    rmSync(work, { recursive: true, force: true });
  }
  return session;
}

function runProcess(command: string, args: string[], cwd: string, stdin: string, timeoutMs: number, log: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      log(`timeout after ${Math.round(timeoutMs / 1000)}s, stopping Claude Code`);
      child.kill();
    }, timeoutMs);
    const pipe = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(line);
    };
    child.stdout.on("data", pipe);
    child.stderr.on("data", pipe);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new Error(claudeNotFound(command)) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) log(`Claude Code exited with code ${code}`);
      resolve();
    });
    child.stdin.end(stdin);
  });
}

/** Fails early with a clear message when the Claude Code CLI cannot be started. Returns its version. */
export function checkClaudeCode(command = process.env.STAYBENCH_CLAUDE_BIN ?? "claude", commandArgs: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, [...commandArgs, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", () => reject(new Error(claudeNotFound(command))));
    // Through cmd.exe a missing command is not ENOENT but a non-zero exit code.
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(claudeNotFound(command)))));
  });
}

function claudeNotFound(command: string): string {
  return `Claude Code CLI not found ("${command}"). Install it (https://claude.com/claude-code), check that "claude --version" works, ` +
    "or point STAYBENCH_CLAUDE_BIN at the executable.";
}

/**
 * On Windows, an npm-installed "claude" is a .cmd shim that only runs through a shell. The command
 * line is then built here, each argument quoted (none of ours contains a quote).
 */
function spawnCli(command: string, args: string[], opts: SpawnOptions): ChildProcessByStdio<Writable, Readable, Readable> {
  if (process.platform !== "win32") return spawn(command, args, opts) as ChildProcessByStdio<Writable, Readable, Readable>;
  const line = [command, ...args].map((a) => (/^[\w./:=-]+$/.test(a) ? a : `"${a}"`)).join(" ");
  return spawn(line, { ...opts, shell: true }) as ChildProcessByStdio<Writable, Readable, Readable>;
}