import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { agentSettings } from "../shared/settings";

vi.mock("./handlers", () => ({
  createFile: vi.fn(), getRuntimeChunk: vi.fn(), getRuntimeInfo: vi.fn(), listFiles: vi.fn(),
  readFile: vi.fn(), statFile: vi.fn(), writeFile: vi.fn(),
}));
vi.mock("./mcp", () => ({ startMcpServer: async () => ({ urlFor: () => "http://127.0.0.1:1234/mcp/test", close: async () => {} }) }));

afterEach(() => vi.restoreAllMocks());

async function runHook(provider: string, settings: unknown, existing?: Record<string, unknown>) {
  let hook: (event: any) => Promise<any> = async () => undefined;
  const server = {
    registerSettings: () => ({ read: async () => { if (settings instanceof Error) throw settings; return settings; } }), handle: vi.fn(),
    before: (_event: string, callback: typeof hook) => { hook = callback; },
  };
  const cleanup = contribute(server as unknown as PluginServerContext);
  try {
    return await hook({ request: { config: { provider, cwd: "/project", mcpServers: existing }, env: { KEEP: "yes" } } });
  } finally {
    await cleanup();
  }
}

describe("agent creation hook", () => {
  it("defaults Pi injection off so runtimes without MCP can still create agents", async () => {
    const values = agentSettings.schema.parse({});
    expect(values.enablePiMcp).toBe(false);
    expect(await runHook("pi/model", { status: "ready", values })).toBeUndefined();
  });
  it("fails closed for Pi when settings are unavailable or invalid", async () => {
    expect(await runHook("pi", { status: "invalid" })).toBeUndefined();
    expect(await runHook("pi", { status: "ready", values: { enablePiMcp: false } })).toBeUndefined();
  });
  it("does not make other providers depend on Pi settings read availability", async () => {
    const denied = new Error("EACCES");
    expect((await runHook("codex", denied)).config.mcpServers.excalidraw).toBeDefined();
    expect(await runHook("pi", denied)).toBeUndefined();
  });
  it("injects for explicitly enabled Pi and preserves existing MCP servers and environment", async () => {
    const result = await runHook("pi/model", { status: "ready", values: { enablePiMcp: true } }, { other: { type: "http", url: "http://localhost/other" } });
    expect(result.env).toEqual({ KEEP: "yes" });
    expect(result.config.mcpServers).toEqual({ other: { type: "http", url: "http://localhost/other" }, excalidraw: { type: "http", url: "http://127.0.0.1:1234/mcp/test" } });
  });
  it("leaves manually configured Excalidraw servers untouched and keeps other providers working", async () => {
    const ready = { status: "ready", values: { enablePiMcp: false } };
    expect(await runHook("pi", ready, { excalidraw: { type: "http", url: "http://localhost/manual" } })).toBeUndefined();
    expect((await runHook("codex", ready)).config.mcpServers.excalidraw).toBeDefined();
    expect(await runHook("unknown", { status: "ready", values: { enablePiMcp: true } })).toBeUndefined();
  });
});
