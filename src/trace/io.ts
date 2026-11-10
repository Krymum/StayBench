import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TraceCall, TraceEnd, TraceHeader, TraceLine } from "./types.js";

/** Writes one JSON object per line, synchronously, so a crash never loses earlier calls. */
export class TraceWriter {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }

  write(line: TraceLine): void {
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }
}

export interface ParsedTrace {
  header: TraceHeader;
  calls: TraceCall[];
  end: TraceEnd | null;
}

export function parseTrace(text: string): ParsedTrace {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as TraceLine;
      } catch {
        throw new Error(`Trace line ${i + 1} is not valid JSON`);
      }
    });
  const header = lines[0];
  if (!header || header.type !== "header") throw new Error("Trace must start with a header line");
  const calls: TraceCall[] = [];
  let end: TraceEnd | null = null;
  for (const [i, l] of lines.slice(1).entries()) {
    if (end) throw new Error(`Trace line ${i + 2}: content after the end line`);
    if (l.type === "call") calls.push(l);
    else if (l.type === "end") end = l;
    else throw new Error(`Trace line ${i + 2}: unexpected "${(l as { type: string }).type}" line`);
  }
  calls.forEach((c, i) => {
    if (c.seq !== i + 1) throw new Error(`Trace call ${i + 1} has seq ${c.seq}`);
  });
  return { header, calls, end };
}

export function readTrace(file: string): ParsedTrace {
  return parseTrace(readFileSync(file, "utf8"));
}

export function serializeTrace(t: ParsedTrace): string {
  const lines: TraceLine[] = [t.header, ...t.calls, ...(t.end ? [t.end] : [])];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}
