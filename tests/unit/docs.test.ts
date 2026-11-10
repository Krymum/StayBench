import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarios } from "../../src/scenarios/loader.js";
import { TOOL_NAMES } from "../../src/session/tools.js";

const DOCS = [
  "README.md",
  "METHODOLOGY.md",
  "DECISIONS.md",
  "docs/presentation.en.md",
  "docs/presentation.fr.md",
  "docs/technical.en.md",
  "docs/technical.fr.md",
];

describe("documentation", () => {
  it("README lists every scenario and every tool", () => {
    const readme = readFileSync("README.md", "utf8");
    for (const s of loadScenarios()) expect(readme, s.id).toContain(`\`${s.id}\``);
    for (const t of TOOL_NAMES) expect(readme, t).toContain(`\`${t}\``);
  });

  it("technical guides document every tool, in both languages", () => {
    for (const f of ["docs/technical.en.md", "docs/technical.fr.md"]) {
      const text = readFileSync(f, "utf8");
      for (const t of TOOL_NAMES) expect(text, `${f}: ${t}`).toContain(`\`${t}\``);
    }
  });

  it.each(DOCS)("relative links in %s point to existing files", (file) => {
    const text = readFileSync(file, "utf8");
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((l) => !/^(https?:|mailto:|#)/.test(l));
    for (const link of links) {
      const target = join(dirname(file), link.split("#")[0]!);
      expect(existsSync(target), `${file} -> ${link}`).toBe(true);
    }
  });
});
