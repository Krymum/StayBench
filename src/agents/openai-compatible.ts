import * as z from "zod/v4";
import { SERVER_INSTRUCTIONS } from "../mcp/server.js";
import { TOOL_DESCRIPTIONS, TOOL_NAMES, TOOL_SCHEMAS } from "../session/tools.js";
import type { Agent, AgentInput, ToolCaller } from "./types.js";

/**
 * Agent driven by a model behind an OpenAI-compatible Chat Completions endpoint
 * (Ollama, llama.cpp server, LM Studio, vLLM...). Intended for free local models.
 * The model only receives the traveler's request text, never the structured constraints.
 */
export interface OpenAICompatibleOptions {
  /** e.g. http://localhost:11434/v1 for Ollama. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Maximum model turns before giving up. */
  maxTurns?: number;
  temperature?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Optional logger for progress (stderr in the CLI). */
  log?: (line: string) => void;
  /** Injectable fetch, for tests. */
  fetch?: typeof fetch;
}

interface ChatToolCall {
  id?: string;
  type?: "function";
  function: { name: string; arguments: string | Record<string, unknown> };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export const SYSTEM_PROMPT = `You are a travel booking agent acting for a traveler. You can only act through the provided tools.
${SERVER_INSTRUCTIONS}
Rules: never invent information; use the exact values returned by the tools in your final report.
You must end by calling submit_final_report exactly once.`;

/** Tool definitions in Chat Completions format, generated from the same Zod schemas as the MCP server. */
export function openAITools() {
  return TOOL_NAMES.map((name) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(TOOL_SCHEMAS[name]) as Record<string, unknown>;
    return { type: "function" as const, function: { name, description: TOOL_DESCRIPTIONS[name], parameters } };
  });
}

export class OpenAICompatibleAgent implements Agent {
  readonly name = "local-openai";

  constructor(private readonly opts: OpenAICompatibleOptions) {}

  get info(): Record<string, unknown> {
    return { name: this.name, model: this.opts.model, base_url: this.opts.baseUrl };
  }

  private async complete(messages: ChatMessage[]): Promise<ChatMessage> {
    const f = this.opts.fetch ?? fetch;
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await f(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages,
        tools: openAITools(),
        tool_choice: "auto",
        temperature: this.opts.temperature ?? 0,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300_000),
    });
    if (!res.ok) throw new Error(`Model endpoint returned HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const body = (await res.json()) as { choices?: Array<{ message?: ChatMessage }> };
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error("Model endpoint returned no message");
    return { role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) };
  }

  async run(call: ToolCaller, input: AgentInput): Promise<void> {
    const log = this.opts.log ?? (() => {});
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input.request },
    ];
    let finished = false;
    let nudges = 0;
    let callSeq = 0;
    const maxTurns = this.opts.maxTurns ?? 40;

    for (let turn = 1; turn <= maxTurns && !finished; turn++) {
      const reply = await this.complete(messages);
      messages.push(reply);
      if (!reply.tool_calls?.length) {
        if (nudges++ >= 2) {
          log(`turn ${turn}: model stopped without a final report`);
          break;
        }
        messages.push({ role: "user", content: "Continue using the tools. When you are done, call submit_final_report." });
        continue;
      }
      for (const tc of reply.tool_calls) {
        const id = tc.id ?? `call_${++callSeq}`;
        tc.id = id;
        let args: Record<string, unknown>;
        try {
          const raw = tc.function.arguments;
          args = typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : {}) : (raw ?? {});
        } catch {
          messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify({ error: { code: "INVALID_ARGUMENTS", message: "Arguments are not valid JSON." } }) });
          continue;
        }
        const outcome = await call(tc.function.name, args);
        log(`turn ${turn}: ${tc.function.name} -> ${outcome.ok ? "ok" : outcome.error.code}`);
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify(outcome.ok ? outcome.data : { error: outcome.error }),
        });
        if (tc.function.name === "submit_final_report" && outcome.ok) finished = true;
      }
    }
  }
}
