import { describe, expect, it } from "vitest";
import { providerSupportsMcp } from "./providers";

describe("providerSupportsMcp", () => {
  it("accepts providers known to support MCP servers, with or without a model suffix", () => {
    for (const provider of ["claude", "codex", "codex/gpt-5.5", "OpenCode", "copilot", "pi", "pi/openai/model", " PI/model ", " claude/haiku "]) {
      expect(providerSupportsMcp(provider), provider).toBe(true);
    }
  });
  it("skips providers that reject MCP servers, unknown providers and missing values", () => {
    for (const provider of ["mock", "some-plugin-provider", "", undefined]) {
      expect(providerSupportsMcp(provider), String(provider)).toBe(false);
    }
  });
});
