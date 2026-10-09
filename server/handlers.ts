import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
  createFileRpc,
  listFilesRpc,
  readFileRpc,
  runtimeChunkRpc,
  statFileRpc,
  writeFileRpc,
} from "../shared/rpc";
import { runtimeChunk, runtimeInfo } from "./assets";
import { createDiagram, listDiagrams, readDiagram, statDiagram, writeDiagram } from "./files";
import { workspaceDirectory } from "./workspace";

export async function listFiles({ workspaceId }: RpcInput<typeof listFilesRpc>, { paseo }: PluginHandlerContext) {
  return listDiagrams(await workspaceDirectory(paseo, workspaceId));
}

export async function statFile(input: RpcInput<typeof statFileRpc>, { paseo }: PluginHandlerContext) {
  return statDiagram(await workspaceDirectory(paseo, input.workspaceId), input.path);
}

export async function readFile(input: RpcInput<typeof readFileRpc>, { paseo }: PluginHandlerContext) {
  return readDiagram(await workspaceDirectory(paseo, input.workspaceId), input.path);
}

export async function writeFile(input: RpcInput<typeof writeFileRpc>, { paseo }: PluginHandlerContext) {
  const result = await writeDiagram(
    await workspaceDirectory(paseo, input.workspaceId),
    input.path,
    input.content,
    input.baseVersion,
  );
  if (result.status === "conflict") console.log(`[excalidraw] stale write rejected for ${input.path}`);
  return result;
}

export async function createFile(input: RpcInput<typeof createFileRpc>, { paseo }: PluginHandlerContext) {
  return createDiagram(await workspaceDirectory(paseo, input.workspaceId), input.path);
}

export function getRuntimeInfo() {
  return runtimeInfo();
}

export function getRuntimeChunk({ hash, index }: RpcInput<typeof runtimeChunkRpc>) {
  return runtimeChunk(hash, index);
}
