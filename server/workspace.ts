import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];

/** Directory of a workspace, from the daemon. Never taken from the client. */
export async function workspaceDirectory(paseo: PaseoApi, workspaceId: string): Promise<string> {
  const handle = paseo.workspaces.ref(workspaceId);
  const directory = handle.directory ?? (await handle.refresh())?.workspaceDirectory ?? null;
  if (!directory) throw new Error(`Unknown workspace: ${workspaceId}`);
  return directory;
}
