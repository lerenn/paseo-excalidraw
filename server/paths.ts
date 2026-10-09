import { promises as fs } from "node:fs";
import path from "node:path";
import { DIAGRAM_EXTENSIONS, isDiagramFileName } from "../shared/formats";

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolve a workspace-relative diagram path (`.excalidraw`, `.excalidraw.svg` or `.excalidraw.png`) to a real absolute path that is guaranteed to
 * sit inside `root`. Rejects absolute paths, `..` escapes and symlinks (to files or to any
 * ancestor directory) that lead outside the workspace. Works for files that do not exist yet:
 * the deepest existing ancestor is resolved through symlinks and re-checked.
 */
export async function resolveDiagramPath(root: string, relative: string): Promise<string> {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\0")) {
    throw new PathError("Invalid path");
  }
  if (path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative) || relative.startsWith("\\")) {
    throw new PathError("Path must be relative to the workspace");
  }
  const normalized = path.normalize(relative);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new PathError("Path escapes the workspace");
  }
  if (!isDiagramFileName(path.basename(normalized))) {
    throw new PathError(`Only ${DIAGRAM_EXTENSIONS.join(", ")} files are supported`);
  }

  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, normalized);
  if (!isInside(realRoot, target)) throw new PathError("Path escapes the workspace");

  // Walk up to the deepest component that exists, resolve it, and re-check containment.
  let existing = target;
  const missing: string[] = [];
  while ((await lstatOrNull(existing)) === null) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new PathError("Path escapes the workspace");
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const realExisting = await fs.realpath(existing).catch(() => {
    throw new PathError("Cannot resolve path");
  });
  if (!isInside(realRoot, realExisting)) throw new PathError("Path escapes the workspace");
  const resolved = path.join(realExisting, ...missing);
  if (!isInside(realRoot, resolved)) throw new PathError("Path escapes the workspace");
  return resolved;
}

/** The path relative to the workspace root, with forward slashes. */
export async function toRelative(root: string, absolute: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  return path.relative(realRoot, absolute).split(path.sep).join("/");
}
