/**
 * The daemon refuses to create or refresh an agent whose provider lacks MCP support if any MCP
 * server is configured ("Provider 'x' does not support MCP servers"). Hooks cannot see provider
 * capabilities, so only inject for providers known to support them; everything else is left alone.
 */
const MCP_PROVIDERS = new Set(["claude", "codex", "opencode", "copilot"]);

/** `provider` may carry a model suffix such as "codex/gpt-5.5". */
export function providerSupportsMcp(provider: string | undefined): boolean {
  if (!provider) return false;
  return MCP_PROVIDERS.has(provider.split("/")[0]!.trim().toLowerCase());
}
