import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiagram, listDiagrams, mutateDiagram, readDiagram, statDiagram, versionOf, writeDiagram } from "./files";
import { PathError } from "./paths";

let base: string;
let root: string;

const scene = (elements: unknown[] = []) => JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} });

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "pe-files-"));
  root = path.join(base, "ws");
  mkdirSync(root);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("file store", () => {
  it("creates, reads, and lists diagrams; lists newest first and skips node_modules and symlinks", async () => {
    const created = await createDiagram(root, "diagrams/one.excalidraw");
    expect(created.path).toBe("diagrams/one.excalidraw");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await createDiagram(root, "two.excalidraw");
    mkdirSync(path.join(root, "node_modules/pkg"), { recursive: true });
    writeFileSync(path.join(root, "node_modules/pkg/x.excalidraw"), scene());
    mkdirSync(path.join(base, "elsewhere"));
    writeFileSync(path.join(base, "elsewhere/leak.excalidraw"), scene());
    symlinkSync(path.join(base, "elsewhere"), path.join(root, "linkdir"));
    const { files, truncated } = await listDiagrams(root);
    expect(files.map((f) => f.path)).toEqual(["two.excalidraw", "diagrams/one.excalidraw"]);
    expect(truncated).toBe(false);
    const read = await readDiagram(root, "diagrams/one.excalidraw");
    expect(read.version).toBe(created.version);
    expect(JSON.parse(read.content).type).toBe("excalidraw");
  });

  it("refuses to create over an existing file or outside the workspace", async () => {
    await createDiagram(root, "a.excalidraw");
    await expect(createDiagram(root, "a.excalidraw")).rejects.toThrow(/already exists/);
    await expect(createDiagram(root, "../b.excalidraw")).rejects.toThrow(PathError);
    expect(readdirSync(base)).toEqual(["ws"]);
  });

  it("writes when the base version matches and rejects a stale base with the current content", async () => {
    const { version } = await createDiagram(root, "a.excalidraw");
    const first = await writeDiagram(root, "a.excalidraw", scene([{ id: "x" }]), version);
    expect(first.status).toBe("ok");
    const stale = await writeDiagram(root, "a.excalidraw", scene([{ id: "y" }]), version);
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") {
      expect(stale.version).toBe((first as { version: string }).version);
      expect(JSON.parse(stale.content).elements).toEqual([{ id: "x" }]);
    }
    expect(JSON.parse(readFileSync(path.join(root, "a.excalidraw"), "utf8")).elements).toEqual([{ id: "x" }]);
  });

  it("serialises concurrent writers: exactly one wins per base version", async () => {
    const { version } = await createDiagram(root, "a.excalidraw");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => writeDiagram(root, "a.excalidraw", scene([{ id: `w${i}` }]), version)),
    );
    expect(results.filter((r) => r.status === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.status === "conflict")).toHaveLength(7);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("an in-process edit between read and write makes the viewer's save stale", async () => {
    const { version } = await createDiagram(root, "a.excalidraw");
    await mutateDiagram(root, "a.excalidraw", (s) => {
      (s.elements as unknown[]).push({ id: "from-agent" });
    });
    const save = await writeDiagram(root, "a.excalidraw", scene([{ id: "from-viewer" }]), version);
    expect(save.status).toBe("conflict");
    if (save.status === "conflict") expect(JSON.parse(save.content).elements).toEqual([{ id: "from-agent" }]);
  });

  it("rejects content that is not an Excalidraw scene and leaves the file untouched", async () => {
    const { version } = await createDiagram(root, "a.excalidraw");
    const before = readFileSync(path.join(root, "a.excalidraw"), "utf8");
    await expect(writeDiagram(root, "a.excalidraw", "not json", version)).rejects.toThrow(/JSON/);
    await expect(writeDiagram(root, "a.excalidraw", JSON.stringify({ type: "other", elements: [] }), version)).rejects.toThrow(/Excalidraw/);
    expect(readFileSync(path.join(root, "a.excalidraw"), "utf8")).toBe(before);
  });

  it("does not follow a symlink out of the workspace on read or write", async () => {
    mkdirSync(path.join(base, "elsewhere"));
    const target = path.join(base, "elsewhere/leak.excalidraw");
    writeFileSync(target, scene([{ id: "secret" }]));
    symlinkSync(target, path.join(root, "leak.excalidraw"));
    await expect(readDiagram(root, "leak.excalidraw")).rejects.toThrow(/escapes/);
    await expect(writeDiagram(root, "leak.excalidraw", scene(), "whatever")).rejects.toThrow(/escapes/);
    expect(JSON.parse(readFileSync(target, "utf8")).elements).toEqual([{ id: "secret" }]);
  });

  it("stat reports existence and a version that tracks content changes", async () => {
    expect(await statDiagram(root, "missing.excalidraw")).toEqual({ exists: false, version: null });
    const { version } = await createDiagram(root, "a.excalidraw");
    expect(await statDiagram(root, "a.excalidraw")).toEqual({ exists: true, version });
    // Same size, different bytes, written right away: the content hash must still change.
    const original = readFileSync(path.join(root, "a.excalidraw"), "utf8");
    writeFileSync(path.join(root, "a.excalidraw"), original.replace("excalidraw", "excalidrAw"));
    const changed = await statDiagram(root, "a.excalidraw");
    expect(changed.version).not.toBe(version);
    expect(changed.version).toBe(versionOf(readFileSync(path.join(root, "a.excalidraw"), "utf8")));
  });
});
