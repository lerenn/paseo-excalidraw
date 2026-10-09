import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { tools, type ToolContext } from "./tools";

/**
 * A minimal MCP server over streamable HTTP (JSON responses, stateless) on 127.0.0.1.
 *
 * Each agent gets its own URL, `/mcp/<cwd>.<hmac>`: the path carries the agent's working
 * directory signed with a secret, so tools are confined to that directory and nobody without the
 * URL can call them. The secret and port persist under $PASEO_HOME/plugin-data so URLs already
 * handed to agents keep working after a plugin reload or daemon restart (the port is reclaimed
 * when it is free; otherwise a new random one is used).
 */

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpEndpoint {
  port: number;
  urlFor(cwd: string): string;
  close(): Promise<void>;
}

interface PersistedState {
  port: number;
  secret: string;
}

export function stateDirectory(): string {
  return path.join(process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"), "plugin-data", "excalidraw");
}

async function loadState(file: string): Promise<PersistedState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<PersistedState>;
    if (typeof parsed.secret === "string" && parsed.secret.length >= 32 && Number.isInteger(parsed.port)) {
      return { port: parsed.port!, secret: parsed.secret };
    }
  } catch {
    // First run, or unreadable: start fresh.
  }
  return null;
}

async function saveState(file: string, state: PersistedState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
}

const sign = (secret: string, cwd: string) => createHmac("sha256", secret).update(cwd).digest("base64url");

export function keyFor(secret: string, cwd: string): string {
  return `${Buffer.from(cwd, "utf8").toString("base64url")}.${sign(secret, cwd)}`;
}

/** The cwd carried by a valid key, or null. Constant-time signature comparison. */
export function cwdFromKey(secret: string, key: string): string | null {
  const [encoded, signature, ...rest] = key.split(".");
  if (!encoded || !signature || rest.length > 0) return null;
  const cwd = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = Buffer.from(sign(secret, cwd));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? cwd : null;
}

function toolList() {
  return tools.map((tool) => {
    const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

function reply(id: JsonRpcMessage["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function fail(id: JsonRpcMessage["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMessage(message: JsonRpcMessage, context: ToolContext) {
  const isNotification = message.id === undefined;
  if (message.method !== "tools/call") console.log(`[excalidraw-mcp] ${String(message.method)}`);
  switch (message.method) {
    case "initialize": {
      const requested = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "";
      return reply(message.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "paseo-excalidraw", version: "0.1.0" },
        instructions:
          "Create and edit Excalidraw diagrams in this project. Call list_diagrams, then read_diagram to get element ids, then use add_shape, connect, update, delete, align or build_diagram.",
      });
    }
    case "ping":
      return reply(message.id, {});
    case "tools/list":
      return reply(message.id, { tools: toolList() });
    case "tools/call": {
      const name = message.params?.name;
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return fail(message.id, -32602, `Unknown tool: ${String(name)}`);
      const parsed = tool.schema.safeParse(message.params?.arguments ?? {});
      if (!parsed.success) {
        return reply(message.id, { isError: true, content: [{ type: "text", text: `Invalid arguments: ${describeIssues(parsed.error)}` }] });
      }
      try {
        const text = await tool.run(parsed.data, context);
        console.log(`[excalidraw-mcp] ${tool.name} ok`);
        return reply(message.id, { content: [{ type: "text", text }] });
      } catch (error) {
        const expected = error instanceof Error && ["PathError", "SceneError", "ColorError"].includes(error.name);
        console.error(`[excalidraw-mcp] ${tool.name} failed${expected ? "" : `: ${(error as Error)?.stack ?? error}`}`);
        const text = expected ? (error as Error).message : "Internal error while editing the diagram";
        return reply(message.id, { isError: true, content: [{ type: "text", text }] });
      }
    }
    default:
      if (isNotification) return null;
      return fail(message.id, -32601, `Method not found: ${String(message.method)}`);
  }
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMcpServer(): Promise<McpEndpoint> {
  const stateFile = path.join(stateDirectory(), "mcp.json");
  const saved = await loadState(stateFile);
  const secret = saved?.secret ?? randomBytes(32).toString("base64url");
  let port = 0;

  const server = http.createServer(async (request, response) => {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      // DNS-rebinding and browser-origin protection: only loopback hosts, no cross-site callers.
      const host = (request.headers.host ?? "").toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: "Forbidden host" });
      if (request.headers.origin) return send(403, { error: "Forbidden origin" });
      const match = /^\/mcp\/([A-Za-z0-9_.-]+)$/.exec((request.url ?? "").split("?")[0] ?? "");
      const cwd = match ? cwdFromKey(secret, match[1]!) : null;
      if (!cwd) return send(404, { error: "Not found" });
      if (request.method !== "POST") return send(405, { error: "Use POST" }, { Allow: "POST" });

      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(request));
      } catch {
        return send(400, fail(null, -32700, "Parse error"));
      }
      const messages = Array.isArray(payload) ? payload : [payload];
      const responses = (
        await Promise.all(
          messages.map((message) =>
            typeof message === "object" && message !== null
              ? handleMessage(message as JsonRpcMessage, { root: cwd })
              : fail(null, -32600, "Invalid request"),
          ),
        )
      ).filter((entry) => entry !== null);
      if (responses.length === 0) return send(202);
      return send(200, Array.isArray(payload) ? responses : responses[0]);
    } catch (error) {
      console.error(`[excalidraw-mcp] request failed: ${(error as Error)?.message ?? error}`);
      if (!response.headersSent) send(500, fail(null, -32603, "Internal error"));
    }
  });

  const listen = (wanted: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(wanted, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  try {
    await listen(saved?.port ?? 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || !saved) throw error;
    await listen(0);
  }
  port = (server.address() as { port: number }).port;
  await saveState(stateFile, { port, secret }).catch((error) => console.error(`[excalidraw-mcp] could not persist endpoint: ${error}`));
  console.log(`[excalidraw-mcp] listening on 127.0.0.1:${port}`);

  return {
    port,
    urlFor: (cwd) => `http://127.0.0.1:${port}/mcp/${keyFor(secret, cwd)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
