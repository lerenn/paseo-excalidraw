import { describe, expect, it } from "vitest";
import { providerSupportsMcp } from "./providers";

describe("providerSupportsMcp", () => {
  it("accepts providers known to support MCP servers, with or without a model suffix", () => {
    for (const provider of ["claude", "codex", "codex/gpt-5.5", "OpenCode", "copilot", " claude/haiku "]) {
      expect(providerSupportsMcp(provider), provider).toBe(true);
    }
  });
  it("only injects for Pi after explicit opt-in, including model-suffixed names", () => {
    for (const provider of ["pi", "pi/openai/model", " PI/model "]) {
      expect(providerSupportsMcp(provider, true)).toBe(true);
      expect(providerSupportsMcp(provider, false)).toBe(false);
    }
    expect(providerSupportsMcp("unknown", true)).toBe(false);
  });
  it("skips providers that reject MCP servers, unknown providers and missing values", () => {
    for (const provider of ["pi", "pi/openai/model", " PI/model ", "mock", "some-plugin-provider", "", undefined]) {
      expect(providerSupportsMcp(provider), String(provider)).toBe(false);
    }
  });
});
