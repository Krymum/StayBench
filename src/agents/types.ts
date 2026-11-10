import type { Client } from "@modelcontextprotocol/client";
import type { Constraints } from "../scenarios/schema.js";
import type { RunSession } from "../session/session.js";
import type { ToolOutcome } from "../trace/types.js";

/** Calls one tool and returns its outcome. Same contract whatever the transport. */
export type ToolCaller = (tool: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

export interface AgentInput {
  /** Natural-language request, as an LLM agent would receive it (starts with the simulated date). */
  request: string;
  /** Simulated date of the run (YYYY-MM-DD). */
  today: string;
  /**
   * Structured version of the request. Only scripted agents use it: they cannot read text.
   * LLM agents never receive it.
   */
  constraints: Constraints;
}

export interface Agent {
  name: string;
  run(call: ToolCaller, input: AgentInput): Promise<void>;
}

/** Calls the session directly (no transport). */
export function sessionCaller(session: RunSession): ToolCaller {
  return async (tool, args) => session.call(tool, args);
}

/** Calls tools through an MCP client and maps tool results back to outcomes. */
export function mcpCaller(client: Client): ToolCaller {
  return async (tool, args) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "null";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (r.isError) {
      const err = (parsed as { error?: { code: string; message: string } })?.error;
      return { ok: false, error: err ?? { code: "INVALID_ARGUMENTS", message: String(parsed) } };
    }
    return { ok: true, data: parsed };
  };
}
