/** `.excalidraw` is plain JSON; the others are exported images with the scene embedded. */
export const DIAGRAM_EXTENSIONS = [".excalidraw", ".excalidraw.svg", ".excalidraw.png"] as const;
export type DiagramFormat = "json" | "svg" | "png";
/** How a format travels over RPC: PNG is binary, so it is sent as base64. */
export type Encoding = "utf8" | "base64";

export function diagramFormat(name: string): DiagramFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".excalidraw.svg")) return "svg";
  if (lower.endsWith(".excalidraw.png")) return "png";
  if (lower.endsWith(".excalidraw")) return "json";
  return null;
}

/** A diagram file name with a non-empty stem, e.g. `a.excalidraw` but not `.excalidraw`. */
export function isDiagramFileName(name: string): boolean {
  const lower = name.toLowerCase();
  const extension = DIAGRAM_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  // ".excalidraw.svg" also ends with... only itself; ".excalidraw" must not match inside it.
  return extension !== undefined && name.length > extension.length;
}

export function encodingOf(format: DiagramFormat): Encoding {
  return format === "png" ? "base64" : "utf8";
}

/** Add `.excalidraw` unless the name already ends with a supported diagram extension. */
export function withDiagramExtension(name: string): string {
  return diagramFormat(name) ? name : `${name}.excalidraw`;
}
