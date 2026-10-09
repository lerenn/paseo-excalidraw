import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startMcpServer } from "./server/mcp";
import { providerSupportsMcp } from "./server/providers";
import { diagramSettings } from "./shared/settings";
import {
  createFileRpc,
  listFilesRpc,
  readFileRpc,
  runtimeChunkRpc,
  runtimeInfoRpc,
  statFileRpc,
  writeFileRpc,
} from "./shared/rpc";
import {
  createFile,
  getRuntimeChunk,
  getRuntimeInfo,
  listFiles,
  readFile,
  statFile,
  writeFile,
} from "./server/handlers";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(diagramSettings);
  server.handle(listFilesRpc, listFiles);
  server.handle(statFileRpc, statFile);
  server.handle(readFileRpc, readFile);
  server.handle(writeFileRpc, writeFile);
  server.handle(createFileRpc, createFile);
  server.handle(runtimeInfoRpc, getRuntimeInfo);
  server.handle(runtimeChunkRpc, getRuntimeChunk);

  // Offer the diagram tools to every new agent, scoped to that agent's working directory.
  const mcp = startMcpServer();
  mcp.catch((error) => console.error(`[excalidraw] MCP server failed to start: ${error?.message ?? error}`));
  server.before("agent.create", async ({ request }) => {
    const cwd = request.config.cwd;
    if (!cwd || !providerSupportsMcp(request.config.provider) || request.config.mcpServers?.excalidraw) return undefined;
    try {
      const endpoint = await mcp;
      return {
        ...request,
        config: {
          ...request.config,
          mcpServers: { ...request.config.mcpServers, excalidraw: { type: "http" as const, url: endpoint.urlFor(cwd) } },
        },
      };
    } catch {
      return undefined;
    }
  });

  return async () => {
    await mcp.then((endpoint) => endpoint.close()).catch(() => undefined);
  };
}
