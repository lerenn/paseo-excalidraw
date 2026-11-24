/**
 * The daemon refuses to create or refresh an agent whose provider lacks MCP support if any MCP
 * server is configured ("Provider 'x' does not support MCP servers"). Hooks cannot see provider
 * capabilities, so only inject for providers known to support them; everything else is left alone.
 */
const MCP_PROVIDERS = new Set(["claude", "codex", "opencode", "copilot"]);

/** `provider` may carry a model suffix such as "codex/gpt-5.5". */
export function providerSupportsMcp(provider: string | undefined, enablePiMcp = false): boolean {
  if (!provider) return false;
  const name = provider.split("/")[0]!.trim().toLowerCase();
  // Pi support depends on its installed runtime; never break agent creation by opting in silently.
  return MCP_PROVIDERS.has(name) || (name === "pi" && enablePiMcp);
}
