import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodePngScene, decodeSvgScene, emptyPng, emptySvg, isPng } from "./embedded";
import { createDiagram, listDiagrams, mutateDiagram, readDiagram, readDiagramScene, statDiagram, versionOf, writeDiagram } from "./files";
import { PathError } from "./paths";
import { summarize, type Scene } from "./scene";

// Produced by Excalidraw's own exportToSvg / exportToBlob with "embed scene" in a real browser:
// a rectangle "Hello 世界", an ellipse "DB" and an arrow "reads" bound between them.
const fixtures = path.join(__dirname, "fixtures");
const exportedSvg = readFileSync(path.join(fixtures, "exported.excalidraw.svg"), "utf8");
const exportedPng = readFileSync(path.join(fixtures, "exported.excalidraw.png"));

let base: string;
let root: string;
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "pe-embedded-"));
  root = path.join(base, "ws");
  mkdirSync(root);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("reading scenes embedded by Excalidraw", () => {
  it("decodes the scene from an exported SVG, including non-ASCII text", () => {
    const scene = JSON.parse(decodeSvgScene(exportedSvg)) as Scene;
    expect(scene.type).toBe("excalidraw");
    expect(scene.elements.filter((e) => e.type === "text").map((e) => e.text).sort()).toEqual(["DB", "Hello 世界", "reads"]);
    const arrow = scene.elements.find((e) => e.type === "arrow")!;
    const idOf = (label: string) => scene.elements.find((e) => e.type === "text" && e.text === label)!.containerId;
    expect([arrow.startBinding.elementId, arrow.endBinding.elementId]).toEqual([idOf("Hello 世界"), idOf("DB")]);
  });

  it("decodes the same scene from an exported PNG", () => {
    expect(isPng(exportedPng)).toBe(true);
    const fromPng = JSON.parse(decodePngScene(exportedPng)) as Scene;
    const fromSvg = JSON.parse(decodeSvgScene(exportedSvg)) as Scene;
    expect(fromPng.type).toBe("excalidraw");
    expect(fromPng.elements.map((e) => e.type).sort()).toEqual(fromSvg.elements.map((e) => e.type).sort());
    expect(fromPng.elements.filter((e) => e.type === "text").map((e) => e.text).sort()).toEqual(["DB", "Hello 世界", "reads"]);
  });

  it("summarises an embedded scene the same way as a plain one", () => {
    const text = summarize(JSON.parse(decodeSvgScene(exportedSvg)) as Scene);
    expect(text).toContain('rectangle "Hello 世界"');
    expect(text).toMatch(/\w+\(Hello 世界\) -> \w+\(DB\) "reads"/);
  });

  it("rejects images without a scene, and corrupt payloads", () => {
    expect(() => decodeSvgScene("<svg xmlns='http://www.w3.org/2000/svg'></svg>")).toThrow(/no embedded/);
    expect(() => decodeSvgScene(exportedSvg.replace(/payload-start -->[^<]+/, "payload-start -->AAAA"))).toThrow(PathError);
    expect(() => decodePngScene(Buffer.from("not a png at all"))).toThrow(/Not a PNG/);
    const truncated = exportedPng.subarray(0, 33); // signature + IHDR only
    expect(() => decodePngScene(truncated)).toThrow(/no embedded/);
  });
});

describe("blank images created by the plugin", () => {
  const scene = JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "a", type: "rectangle" }], appState: {}, files: {} });

  it("emptySvg round-trips through the same decoder Excalidraw's format needs", () => {
    const svg = emptySvg(scene);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(JSON.parse(decodeSvgScene(svg))).toEqual(JSON.parse(scene));
  });

  it("emptyPng is a structurally valid PNG whose chunk CRCs match node's crc32", () => {
    const png = emptyPng(scene);
    expect(JSON.parse(decodePngScene(png))).toEqual(JSON.parse(scene));
    let offset = 8;
    const types: string[] = [];
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.toString("ascii", offset + 4, offset + 8);
      types.push(type);
      const body = png.subarray(offset + 4, offset + 8 + length);
      expect(png.readUInt32BE(offset + 8 + length)).toBe(crc32(body));
      if (type === "IDAT") expect([...inflateSync(png.subarray(offset + 8, offset + 8 + length))]).toEqual([0, 255, 255, 255]);
      offset += 12 + length;
    }
    expect(types).toEqual(["IHDR", "tEXt", "IDAT", "IEND"]);
    expect(offset).toBe(png.length);
  });
});

describe("image diagrams in the file store", () => {
  it("creates, lists, reads and versions svg and png diagrams", async () => {
    const svg = await createDiagram(root, "pics/a.excalidraw.svg");
    const png = await createDiagram(root, "pics/b.excalidraw.png");
    await createDiagram(root, "c.excalidraw");
    const listed = (await listDiagrams(root)).files.map((f) => f.path).sort();
    expect(listed).toEqual(["c.excalidraw", "pics/a.excalidraw.svg", "pics/b.excalidraw.png"]);

    const readSvg = await readDiagram(root, "pics/a.excalidraw.svg");
    expect(readSvg).toMatchObject({ encoding: "utf8", version: svg.version });
    const readPng = await readDiagram(root, "pics/b.excalidraw.png");
    expect(readPng.encoding).toBe("base64");
    expect(readPng.version).toBe(png.version);
    expect(Buffer.from(readPng.content, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(JSON.parse(await readDiagramScene(root, "pics/b.excalidraw.png")).elements).toEqual([]);
    expect(await statDiagram(root, "pics/b.excalidraw.png")).toEqual({ exists: true, version: png.version });
  });

  it("saves a viewer-exported SVG and PNG with version checks, and refuses images with no scene", async () => {
    const svg = await createDiagram(root, "a.excalidraw.svg");
    const ok = await writeDiagram(root, "a.excalidraw.svg", exportedSvg, svg.version);
    expect(ok.status).toBe("ok");
    expect(readFileSync(path.join(root, "a.excalidraw.svg"), "utf8")).toBe(exportedSvg);
    expect((await writeDiagram(root, "a.excalidraw.svg", exportedSvg, svg.version)).status).toBe("conflict");
    await expect(writeDiagram(root, "a.excalidraw.svg", "<svg></svg>", (ok as { version: string }).version)).rejects.toThrow(/no embedded/);

    const png = await createDiagram(root, "b.excalidraw.png");
    const saved = await writeDiagram(root, "b.excalidraw.png", exportedPng.toString("base64"), png.version);
    expect(saved).toMatchObject({ status: "ok", version: versionOf(exportedPng) });
    expect(readFileSync(path.join(root, "b.excalidraw.png")).equals(exportedPng)).toBe(true);
    const conflict = await writeDiagram(root, "b.excalidraw.png", exportedPng.toString("base64"), png.version);
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") expect(Buffer.from(conflict.content, "base64").equals(exportedPng)).toBe(true);
    await expect(writeDiagram(root, "b.excalidraw.png", Buffer.from("plain text").toString("base64"), versionOf(exportedPng))).rejects.toThrow(/Not a PNG/);
  });

  it("never lets a server-side edit rewrite an image", async () => {
    copyFileSync(path.join(fixtures, "exported.excalidraw.svg"), path.join(root, "x.excalidraw.svg"));
    const before = readFileSync(path.join(root, "x.excalidraw.svg"));
    await expect(mutateDiagram(root, "x.excalidraw.svg", () => undefined)).rejects.toThrow(/only be edited in the Paseo Excalidraw panel/);
    expect(readFileSync(path.join(root, "x.excalidraw.svg")).equals(before)).toBe(true);
    expect(readdirSync(root)).toEqual(["x.excalidraw.svg"]);
  });
});
