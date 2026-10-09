import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathError, resolveDiagramPath } from "./paths";

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "pe-paths-"));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  mkdirSync(path.join(root, "docs"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.excalidraw"), "{}");
  writeFileSync(path.join(root, "docs", "a.excalidraw"), "{}");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("resolveDiagramPath", () => {
  it("resolves files inside the workspace, existing or not", async () => {
    const real = await import("node:fs").then((fs) => fs.realpathSync(root));
    expect(await resolveDiagramPath(root, "docs/a.excalidraw")).toBe(path.join(real, "docs", "a.excalidraw"));
    expect(await resolveDiagramPath(root, "new/deeper/b.excalidraw")).toBe(path.join(real, "new", "deeper", "b.excalidraw"));
  });

  it.each(["../outside/secret.excalidraw", "docs/../../outside/secret.excalidraw", "..", "docs/../.."])(
    "rejects parent traversal %s",
    async (relative) => {
      await expect(resolveDiagramPath(root, relative)).rejects.toThrow(PathError);
    },
  );

  it("rejects absolute paths, empty paths, NUL bytes and other extensions", async () => {
    await expect(resolveDiagramPath(root, path.join(outside, "secret.excalidraw"))).rejects.toThrow(/relative/);
    await expect(resolveDiagramPath(root, "")).rejects.toThrow(PathError);
    await expect(resolveDiagramPath(root, "a\0.excalidraw")).rejects.toThrow(PathError);
    await expect(resolveDiagramPath(root, "docs/a.json")).rejects.toThrow(/\.excalidraw/);
    await expect(resolveDiagramPath(root, "docs/.excalidraw")).rejects.toThrow(PathError);
  });

  it("rejects a symlinked file that points outside", async () => {
    symlinkSync(path.join(outside, "secret.excalidraw"), path.join(root, "link.excalidraw"));
    await expect(resolveDiagramPath(root, "link.excalidraw")).rejects.toThrow(/escapes/);
  });

  it("rejects a symlinked directory that points outside, for existing and new files", async () => {
    symlinkSync(outside, path.join(root, "linked"));
    await expect(resolveDiagramPath(root, "linked/secret.excalidraw")).rejects.toThrow(/escapes/);
    await expect(resolveDiagramPath(root, "linked/new.excalidraw")).rejects.toThrow(/escapes/);
    await expect(resolveDiagramPath(root, "linked/sub/new.excalidraw")).rejects.toThrow(/escapes/);
  });

  it("allows a symlink that stays inside the workspace", async () => {
    symlinkSync(path.join(root, "docs"), path.join(root, "alias"));
    const real = await import("node:fs").then((fs) => fs.realpathSync(root));
    expect(await resolveDiagramPath(root, "alias/a.excalidraw")).toBe(path.join(real, "docs", "a.excalidraw"));
  });

  it("rejects a dangling symlink", async () => {
    symlinkSync(path.join(outside, "missing"), path.join(root, "dangling"));
    await expect(resolveDiagramPath(root, "dangling/x.excalidraw")).rejects.toThrow(PathError);
  });

  it("does not treat a sibling directory sharing a prefix as inside", async () => {
    const sibling = `${root}-evil`;
    mkdirSync(sibling);
    symlinkSync(sibling, path.join(root, "sib"));
    await expect(resolveDiagramPath(root, "sib/x.excalidraw")).rejects.toThrow(/escapes/);
  });
});
