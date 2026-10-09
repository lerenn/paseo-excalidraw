import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { decodePngScene, decodeSvgScene, emptyPng, emptySvg, isPng } from "./embedded";
import { diagramFormat, encodingOf, isDiagramFileName, type DiagramFormat, type Encoding } from "../shared/formats";
import { PathError, resolveDiagramPath, toRelative } from "./paths";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_LISTED = 500;
const MAX_DEPTH = 8;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".hg", ".svn", ".dev", "dist", "build"]);

export const EMPTY_SCENE = {
  type: "excalidraw",
  version: 2,
  source: "paseo-excalidraw",
  elements: [] as unknown[],
  appState: { viewBackgroundColor: "#ffffff", gridSize: null },
  files: {},
};

export function versionOf(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function formatOfPath(relative: string): DiagramFormat {
  const format = diagramFormat(relative);
  if (!format) throw new PathError("Unsupported diagram file type");
  return format;
}

export function validateSceneText(content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PathError("Content is not valid JSON");
  }
  const scene = parsed as { type?: unknown; elements?: unknown };
  if (typeof parsed !== "object" || parsed === null || scene.type !== "excalidraw" || !Array.isArray(scene.elements)) {
    throw new PathError('Content is not an Excalidraw scene (expected {"type":"excalidraw","elements":[...]})');
  }
}

/** Check that bytes are a valid diagram of `format`, and return the scene JSON they carry. */
export function validateDiagramBytes(format: DiagramFormat, bytes: Buffer): string {
  if (format === "json") {
    const text = bytes.toString("utf8");
    validateSceneText(text);
    return text;
  }
  const sceneText = format === "svg" ? decodeSvgScene(bytes.toString("utf8")) : decodePngScene(bytes);
  if (format === "png" && !isPng(bytes)) throw new PathError("Not a PNG file");
  validateSceneText(sceneText);
  return sceneText;
}

/** The Excalidraw scene inside any diagram file, as JSON text. */
export function sceneTextOf(format: DiagramFormat, bytes: Buffer): string {
  return validateDiagramBytes(format, bytes);
}

// One writer per file: every read-modify-write in this process goes through here.
const locks = new Map<string, Promise<unknown>>();
export function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

async function readIfExists(absolute: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new PathError("Not a file");
    if (stat.size > MAX_FILE_BYTES) throw new PathError("File is too large");
    return await fs.readFile(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(absolute: string, content: string | Buffer): Promise<void> {
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, absolute);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export interface DiagramListing {
  files: { path: string; size: number; mtimeMs: number }[];
  truncated: boolean;
}

export async function listDiagrams(root: string): Promise<DiagramListing> {
  const realRoot = await fs.realpath(root);
  const files: DiagramListing["files"] = [];
  let truncated = false;
  async function walk(directory: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_LISTED) {
        truncated = true;
        return;
      }
      const full = path.join(directory, entry.name);
      // Symlinks are never followed while listing, so a link cannot lead outside the workspace.
      if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && isDiagramFileName(entry.name) && !entry.name.startsWith(".")) {
        const stat = await fs.stat(full);
        files.push({ path: path.relative(realRoot, full).split(path.sep).join("/"), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(realRoot, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { files, truncated };
}

export async function readDiagram(
  root: string,
  relative: string,
): Promise<{ content: string; encoding: Encoding; version: string }> {
  const absolute = await resolveDiagramPath(root, relative);
  const bytes = await readIfExists(absolute);
  if (bytes === null) throw new PathError(`File not found: ${relative}`);
  const encoding = encodingOf(formatOfPath(relative));
  return { content: bytes.toString(encoding), encoding, version: versionOf(bytes) };
}

/** The Excalidraw scene (JSON text) of a diagram in any format, for tools that only read. */
export async function readDiagramScene(root: string, relative: string): Promise<string> {
  const absolute = await resolveDiagramPath(root, relative);
  const bytes = await readIfExists(absolute);
  if (bytes === null) throw new PathError(`File not found: ${relative}`);
  return sceneTextOf(formatOfPath(relative), bytes);
}

// Hashing re-reads the file; skip that while mtime and size are unchanged (the 1s poll hits this).
const statCache = new Map<string, { stamp: string; version: string }>();

export async function statDiagram(root: string, relative: string): Promise<{ exists: boolean; version: string | null }> {
  const absolute = await resolveDiagramPath(root, relative);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, version: null };
    throw error;
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = statCache.get(absolute);
  if (cached?.stamp === stamp) return { exists: true, version: cached.version };
  const bytes = await readIfExists(absolute);
  if (bytes === null) return { exists: false, version: null };
  const version = versionOf(bytes);
  statCache.set(absolute, { stamp, version });
  return { exists: true, version };
}

export type WriteResult =
  | { status: "ok"; version: string }
  | { status: "conflict"; version: string; content: string };

/** Write only if the file is still at `baseVersion`; otherwise report the current content. */
export async function writeDiagram(
  root: string,
  relative: string,
  content: string,
  baseVersion: string,
): Promise<WriteResult> {
  const format = formatOfPath(relative);
  const encoding = encodingOf(format);
  const bytes = Buffer.from(content, encoding);
  validateDiagramBytes(format, bytes);
  if (bytes.length > MAX_FILE_BYTES) throw new PathError("Content is too large");
  const absolute = await resolveDiagramPath(root, relative);
  return withFileLock(absolute, async () => {
    const current = await readIfExists(absolute);
    if (current === null) throw new PathError(`File not found: ${relative}`);
    const currentVersion = versionOf(current);
    if (currentVersion !== baseVersion) {
      return { status: "conflict", version: currentVersion, content: current.toString(encoding) };
    }
    if (current.equals(bytes)) return { status: "ok", version: currentVersion };
    await atomicWrite(absolute, bytes);
    return { status: "ok", version: versionOf(bytes) };
  });
}

/**
 * Read-modify-write for server-side edits (MCP tools). Holds the same lock as `writeDiagram`,
 * so an agent edit and a viewer save never interleave.
 */
export async function mutateDiagram<T>(
  root: string,
  relative: string,
  mutate: (scene: Record<string, unknown>) => T,
): Promise<{ result: T; version: string }> {
  if (formatOfPath(relative) !== "json") {
    throw new PathError(
      "Image diagrams (.excalidraw.svg / .excalidraw.png) can only be edited in the Paseo Excalidraw panel, because the picture has to be re-rendered. Edit a .excalidraw file instead, or ask the user to edit this one.",
    );
  }
  const absolute = await resolveDiagramPath(root, relative);
  return withFileLock(absolute, async () => {
    const current = await readIfExists(absolute);
    if (current === null) throw new PathError(`File not found: ${relative}`);
    validateSceneText(current.toString("utf8"));
    const scene = JSON.parse(current.toString("utf8")) as Record<string, unknown>;
    const result = mutate(scene);
    const next = `${JSON.stringify(scene, null, 2)}\n`;
    await atomicWrite(absolute, next);
    return { result, version: versionOf(next) };
  });
}

export async function createDiagram(root: string, relative: string): Promise<{ path: string; version: string }> {
  const absolute = await resolveDiagramPath(root, relative);
  return withFileLock(absolute, async () => {
    if ((await readIfExists(absolute)) !== null) throw new PathError(`File already exists: ${relative}`);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    // mkdir may have followed a symlink created meanwhile; re-validate before writing.
    const checked = await resolveDiagramPath(root, relative);
    const sceneText = JSON.stringify(EMPTY_SCENE);
    const format = formatOfPath(relative);
    const content: string | Buffer =
      format === "json" ? `${JSON.stringify(EMPTY_SCENE, null, 2)}\n` : format === "svg" ? emptySvg(sceneText) : emptyPng(sceneText);
    await atomicWrite(checked, content);
    return { path: await toRelative(root, checked), version: versionOf(content) };
  });
}
