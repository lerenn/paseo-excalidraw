import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES, readDiagramImage } from "./images";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("image reads", () => {
  it("rejects oversized files before reading or base64 encoding their contents", async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "excalidraw-image-limit-"));
    const file = path.join(root, "large.excalidraw.png");
    await fs.writeFile(file, "");
    await fs.truncate(file, MAX_IMAGE_BYTES + 1);
    const read = vi.spyOn(fs, "readFile");
    await expect(readDiagramImage(root, "large.excalidraw.png")).rejects.toThrow("limit 4 MiB");
    expect(read).not.toHaveBeenCalled();
  });
});
