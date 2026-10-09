import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cwdFromKey, keyFor, startMcpServer, type McpEndpoint } from "./mcp";

let base: string;
let workspace: string;
let endpoint: McpEndpoint;
let previousHome: string | undefined;

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), "pe-mcp-"));
  workspace = path.join(base, "ws");
  mkdirSync(workspace);
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = path.join(base, "home");
  endpoint = await startMcpServer();
});
afterEach(async () => {
  await endpoint.close();
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  rmSync(base, { recursive: true, force: true });
});

let nextId = 1;
async function rpc(url: string, method: string, params?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return { status: response.status, body: response.status === 202 ? null : ((await response.json()) as any) };
}
async function call(name: string, args: Record<string, unknown>, url = endpoint.urlFor(workspace)) {
  const { body } = await rpc(url, "tools/call", { name, arguments: args });
  return { text: body.result.content[0].text as string, isError: Boolean(body.result.isError) };
}
const readScene = (file: string) => JSON.parse(readFileSync(path.join(workspace, file), "utf8"));

describe("protocol", () => {
  it("performs the MCP handshake and lists tools with JSON schemas", async () => {
    const url = endpoint.urlFor(workspace);
    const init = await rpc(url, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "paseo-excalidraw" } });
    const notification = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(notification.status).toBe(202);
    const list = await rpc(url, "tools/list");
    const names = list.body.result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_diagrams", "read_diagram", "create_diagram", "add_shape", "add_text", "connect", "update", "delete", "align"]));
    const addShape = list.body.result.tools.find((tool: any) => tool.name === "add_shape");
    expect(addShape.inputSchema.type).toBe("object");
    expect(addShape.inputSchema.properties.kind.enum).toEqual(["rectangle", "ellipse", "diamond"]);
    expect(addShape.inputSchema.required).toEqual(expect.arrayContaining(["path", "kind"]));
    expect(addShape.inputSchema.$schema).toBeUndefined();
  });

  it("falls back to a supported protocol version and rejects unknown methods and tools", async () => {
    const url = endpoint.urlFor(workspace);
    expect((await rpc(url, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(url, "nope")).body.error.code).toBe(-32601);
    expect((await rpc(url, "tools/call", { name: "nope", arguments: {} })).body.error.code).toBe(-32602);
  });

  it("answers batches and rejects malformed JSON", async () => {
    const url = endpoint.urlFor(workspace);
    const batch = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]) });
    expect(((await batch.json()) as unknown[]).length).toBe(2);
    const bad = await fetch(url, { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
  });
});

describe("authentication", () => {
  it("rejects a tampered key, another cwd's signature, and unknown paths", async () => {
    const good = endpoint.urlFor(workspace);
    expect((await rpc(good.slice(0, -2) + "xx", "ping")).status).toBe(404);
    const other = endpoint.urlFor(path.join(base, "other"));
    const forged = `${good.split("/mcp/")[0]}/mcp/${other.split("/mcp/")[1]!.split(".")[0]}.${good.split(".").pop()}`;
    expect((await rpc(forged, "ping")).status).toBe(404);
    expect((await rpc(`http://127.0.0.1:${endpoint.port}/mcp/whatever`, "ping")).status).toBe(404);
    expect((await rpc(`http://127.0.0.1:${endpoint.port}/`, "ping")).status).toBe(404);
  });

  it("only accepts POST, and refuses foreign Host or any Origin header", async () => {
    const url = endpoint.urlFor(workspace);
    expect((await fetch(url)).status).toBe(405);
    const withHeaders = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const request = http.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.on("error", reject);
        request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
      });
    expect(await withHeaders({ host: "evil.example" })).toBe(403);
    expect(await withHeaders({ origin: "https://evil.example" })).toBe(403);
    expect(await withHeaders({})).toBe(200);
  });

  it("key round-trips the cwd and refuses other secrets", () => {
    const key = keyFor("s".repeat(40), "/some/dir");
    expect(cwdFromKey("s".repeat(40), key)).toBe("/some/dir");
    expect(cwdFromKey("t".repeat(40), key)).toBeNull();
    expect(cwdFromKey("s".repeat(40), "garbage")).toBeNull();
  });

  it("keeps the same port and secret after a restart, so existing agent URLs still work", async () => {
    const before = endpoint.urlFor(workspace);
    await endpoint.close();
    endpoint = await startMcpServer();
    expect(endpoint.urlFor(workspace)).toBe(before);
    expect((await rpc(before, "ping")).status).toBe(200);
  });
});

describe("tools edit real files", () => {
  it("builds a small diagram end to end and the result is consistent", async () => {
    expect((await call("list_diagrams", {})).text).toMatch(/No diagrams/);
    expect((await call("create_diagram", { path: "docs/arch" })).text).toMatch(/Created docs\/arch\.excalidraw/);
    const web = await call("add_shape", { path: "docs/arch", kind: "rectangle", label: "Web", color: "blue", background: "blue" });
    const db = await call("add_shape", { path: "docs/arch.excalidraw", kind: "ellipse", label: "DB" });
    expect(web.text).toMatch(/^Added \w{6} rectangle "Web"/);
    const connected = await call("connect", { path: "docs/arch", from: "Web", to: "DB", label: "reads" });
    expect(connected.text).toMatch(/^Added arrow/);
    const read = await call("read_diagram", { path: "docs/arch" });
    expect(read.text).toContain('"Web"');
    expect(read.text).toMatch(/\(Web\) -> \w{6}\(DB\) "reads"/);
    const scene = readScene("docs/arch.excalidraw");
    expect(scene.type).toBe("excalidraw");
    const shape = scene.elements.find((e: any) => e.type === "rectangle");
    expect(shape).toMatchObject({ strokeColor: "#1971c2", backgroundColor: "#a5d8ff" });
    expect(db.text).toContain("DB");
    expect((await call("list_diagrams", {})).text).toContain("docs/arch.excalidraw");
  });

  it("build_diagram lays out nodes by their connections and wires every edge", async () => {
    await call("create_diagram", { path: "flow" });
    const built = await call("build_diagram", {
      path: "flow",
      nodes: [{ key: "A" }, { key: "B" }, { key: "C", kind: "diamond" }, { key: "D" }],
      edges: [{ from: "A", to: "B" }, { from: "A", to: "C", label: "maybe" }, { from: "B", to: "D" }],
    });
    expect(built.isError).toBe(false);
    const scene = readScene("flow.excalidraw");
    const x = (label: string) => {
      const text = scene.elements.find((e: any) => e.type === "text" && e.text === label);
      return scene.elements.find((e: any) => e.id === text.containerId).x;
    };
    expect(x("A")).toBeLessThan(x("B"));
    expect(x("B")).toBeLessThan(x("D"));
    expect(x("B")).toBe(x("C"));
    expect(scene.elements.filter((e: any) => e.type === "arrow")).toHaveLength(3);
    const bad = await call("build_diagram", { path: "flow", nodes: [{ key: "A" }], edges: [{ from: "A", to: "Z" }] });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toMatch(/unknown node key/);
  });

  it("update, align and delete work through the tools, and deletions keep tombstones", async () => {
    await call("create_diagram", { path: "d" });
    const ids = [];
    for (const label of ["one", "two", "three"]) {
      ids.push(/Added (\w{6})/.exec((await call("add_shape", { path: "d", kind: "rectangle", label, x: ids.length * 300, y: ids.length * 100 })).text)![1]!);
    }
    expect((await call("update", { path: "d", id: ids[0]!, label: "uno", background: "yellow" })).text).toContain('"uno"');
    expect((await call("align", { path: "d", ids, mode: "top" })).text).toMatch(/Aligned 3/);
    expect((await call("delete", { path: "d", ids: [ids[1]!] })).text).toMatch(/Deleted 2/);
    const scene = readScene("d.excalidraw");
    expect(scene.elements.filter((e: any) => e.isDeleted)).toHaveLength(2);
    expect((await call("read_diagram", { path: "d" })).text).not.toContain('"two"');
    const missing = await call("update", { path: "d", id: "nope", label: "x" });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toMatch(/No element/);
  });

  it("returns readable errors for invalid arguments and colors", async () => {
    await call("create_diagram", { path: "e" });
    const badKind = await call("add_shape", { path: "e", kind: "star" });
    expect(badKind.isError).toBe(true);
    expect(badKind.text).toMatch(/^Invalid arguments: kind/);
    const badColor = await call("add_shape", { path: "e", kind: "rectangle", color: "chartreuse-ish" });
    expect(badColor).toMatchObject({ isError: true });
    expect(badColor.text).toMatch(/Unknown stroke color/);
    expect((await call("read_diagram", { path: "nope" })).text).toMatch(/not found/);
  });
});

describe("image diagrams", () => {
  it("agents can list and read .excalidraw.svg/.png but not edit them", async () => {
    copyFileSync(path.join(__dirname, "fixtures", "exported.excalidraw.svg"), path.join(workspace, "pic.excalidraw.svg"));
    copyFileSync(path.join(__dirname, "fixtures", "exported.excalidraw.png"), path.join(workspace, "pic.excalidraw.png"));
    expect((await call("list_diagrams", {})).text).toMatch(/pic\.excalidraw\.png[\s\S]*pic\.excalidraw\.svg|pic\.excalidraw\.svg[\s\S]*pic\.excalidraw\.png/);
    for (const file of ["pic.excalidraw.svg", "pic.excalidraw.png"]) {
      const read = await call("read_diagram", { path: file });
      expect(read.isError, file).toBe(false);
      expect(read.text).toContain('"Hello 世界"');
      const edit = await call("add_shape", { path: file, kind: "rectangle" });
      expect(edit.isError, file).toBe(true);
      expect(edit.text).toMatch(/only be edited in the Paseo Excalidraw panel/);
    }
    expect((await call("create_diagram", { path: "new.excalidraw.svg" })).isError).toBe(false);
    expect((await call("read_diagram", { path: "new.excalidraw.svg" })).text).toMatch(/Empty diagram/);
  });
});

describe("tools stay inside the agent's directory", () => {
  it("rejects traversal, outside absolute paths and symlink escapes, and never writes outside", async () => {
    const outside = path.join(base, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.excalidraw"), JSON.stringify({ type: "excalidraw", elements: [] }));
    symlinkSync(outside, path.join(workspace, "link"));
    for (const attempt of ["../outside/new", path.join(outside, "x"), "link/new", "link/secret"]) {
      const created = await call("create_diagram", { path: attempt });
      expect(created.isError, attempt).toBe(true);
      const read = await call("read_diagram", { path: attempt });
      expect(read.isError, attempt).toBe(true);
    }
    expect((await call("add_shape", { path: "link/secret", kind: "rectangle" })).isError).toBe(true);
    expect(readFileSync(path.join(outside, "secret.excalidraw"), "utf8")).toBe(JSON.stringify({ type: "excalidraw", elements: [] }));
    expect(readdirSync(outside)).toEqual(["secret.excalidraw"]);
  });

  it("another agent's URL is confined to its own directory", async () => {
    const second = path.join(base, "ws2");
    mkdirSync(second);
    await call("create_diagram", { path: "mine" });
    const other = endpoint.urlFor(second);
    expect((await call("read_diagram", { path: "mine" }, other)).isError).toBe(true);
    expect((await call("list_diagrams", {}, other)).text).toMatch(/No diagrams/);
  });
});
