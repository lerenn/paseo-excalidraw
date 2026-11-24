import { diagramFormat } from "../shared/formats";
import { readDiagram } from "./files";
import { isPng } from "./embedded";
import { PathError } from "./paths";

// Bound model request size and decoded image memory; the editor can still open larger diagrams.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;

export async function readDiagramImage(root: string, relative: string) {
  if (diagramFormat(relative) !== "png") {
    throw new PathError("Visual reading requires a .excalidraw.png whiteboard. Create one in the Paseo panel, or use read_diagram for a structural summary.");
  }
  const image = await readDiagram(root, relative, MAX_IMAGE_BYTES);
  const bytes = Buffer.from(image.content, "base64");
  if (!isPng(bytes) || bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new PathError("Not a PNG image");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new PathError("Whiteboard image must be between 1 and 4096 pixels per dimension; split it into smaller whiteboards");
  }
  let offset = 33;
  let hasPixels = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT" && length > 0) hasPixels = true;
    if (type === "IEND") {
      if (length === 0 && end === bytes.length && hasPixels) return image;
      break;
    }
    if (type === "IHDR") break;
    offset = end;
  }
  throw new PathError("PNG image is truncated or missing pixel data; save the whiteboard again");
}
