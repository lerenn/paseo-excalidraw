import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { runtimeHtml } from "./runtime.gen";

// Raw bytes per RPC chunk; base64 makes it ~1.33x. Keeps every frame far below relay limits.
const CHUNK_BYTES = 384 * 1024;

interface PreparedRuntime {
  hash: string;
  chunks: Buffer[];
  bytes: number;
}

let prepared: PreparedRuntime | null = null;

/** Gzip once; the content hash lets clients cache the runtime and skip the transfer next time. */
export function preparedRuntime(): PreparedRuntime {
  if (!prepared) {
    const compressed = gzipSync(Buffer.from(runtimeHtml, "utf8"), { level: 9 });
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < compressed.length; offset += CHUNK_BYTES) {
      chunks.push(compressed.subarray(offset, offset + CHUNK_BYTES));
    }
    prepared = {
      hash: createHash("sha256").update(compressed).digest("hex").slice(0, 16),
      chunks,
      bytes: compressed.length,
    };
  }
  return prepared;
}

export function runtimeInfo() {
  const runtime = preparedRuntime();
  return { hash: runtime.hash, chunks: runtime.chunks.length, bytes: runtime.bytes };
}

export function runtimeChunk(hash: string, index: number): { base64: string } {
  const runtime = preparedRuntime();
  if (hash !== runtime.hash) throw new Error("Runtime changed; reload the diagram");
  const chunk = runtime.chunks[index];
  if (!chunk) throw new Error("No such runtime chunk");
  return { base64: chunk.toString("base64") };
}
