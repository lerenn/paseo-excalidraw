import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const workspaceId = z.string().min(1);
/** Workspace-relative path of a `.excalidraw`, `.excalidraw.svg` or `.excalidraw.png` file. */
const diagramPath = z.string().min(1).max(500);

export const listFilesRpc = defineRpc({
  name: "excalidraw.file.list.request",
  input: z.object({ workspaceId }),
  output: z.object({
    files: z.array(z.object({ path: diagramPath, size: z.number(), mtimeMs: z.number() })),
    truncated: z.boolean(),
  }),
});

export const statFileRpc = defineRpc({
  name: "excalidraw.file.stat.request",
  input: z.object({ workspaceId, path: diagramPath }),
  output: z.object({ exists: z.boolean(), version: z.string().nullable() }),
});

export const readFileRpc = defineRpc({
  name: "excalidraw.file.read.request",
  input: z.object({ workspaceId, path: diagramPath }),
  output: z.object({ content: z.string(), encoding: z.enum(["utf8", "base64"]), version: z.string() }),
});

export const writeFileRpc = defineRpc({
  name: "excalidraw.file.write.request",
  input: z.object({
    workspaceId,
    path: diagramPath,
    content: z.string(),
    /** Version the client last saw. A different current version means the write is stale. */
    baseVersion: z.string(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), version: z.string() }),
    z.object({ status: z.literal("conflict"), version: z.string(), content: z.string() }),
  ]),
});

export const createFileRpc = defineRpc({
  name: "excalidraw.file.create.request",
  input: z.object({ workspaceId, path: diagramPath }),
  output: z.object({ path: diagramPath, version: z.string() }),
});

export const runtimeInfoRpc = defineRpc({
  name: "excalidraw.runtime.get_info.request",
  input: z.object({}),
  output: z.object({ hash: z.string(), chunks: z.number().int(), bytes: z.number().int() }),
});

export const runtimeChunkRpc = defineRpc({
  name: "excalidraw.runtime.get_chunk.request",
  input: z.object({ hash: z.string(), index: z.number().int().min(0) }),
  output: z.object({ base64: z.string() }),
});
