import { deflateSync, inflateSync } from "node:zlib";
import { PathError } from "./paths";

/**
 * Excalidraw can embed a scene in an exported image: `.excalidraw.svg` (a comment inside
 * `<metadata>`) and `.excalidraw.png` (a tEXt chunk). The payload is JSON `{version, encoding:
 * "bstring", compressed, encoded}` where `encoded` is the zlib-deflated scene as a binary string.
 * This module reads that payload and writes a minimal valid file for a new, empty diagram. It
 * cannot render pictures, so it never rewrites the image of an existing file.
 */

const MIME = "application/vnd.excalidraw+json";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Payload {
  version?: string;
  encoding?: string;
  compressed?: boolean;
  encoded?: string;
}

function encodePayload(sceneText: string): string {
  const compressed = deflateSync(Buffer.from(sceneText, "utf8"));
  const payload: Payload = { version: "1", encoding: "bstring", compressed: true, encoded: compressed.toString("latin1") };
  return JSON.stringify(payload);
}

function decodePayload(payloadJson: string): string {
  let payload: Payload;
  try {
    payload = JSON.parse(payloadJson) as Payload;
  } catch {
    throw new PathError("Embedded Excalidraw data is corrupt");
  }
  if (typeof payload.encoded !== "string") throw new PathError("Embedded Excalidraw data is corrupt");
  const bytes = Buffer.from(payload.encoded, "latin1");
  try {
    return (payload.compressed ? inflateSync(bytes) : bytes).toString("utf8");
  } catch {
    throw new PathError("Embedded Excalidraw data is corrupt");
  }
}

export function decodeSvgScene(svg: string): string {
  const match = /<!--\s*payload-start\s*-->\s*([A-Za-z0-9+/=\s]+?)\s*<!--\s*payload-end\s*-->/.exec(svg);
  if (!match) throw new PathError("This SVG has no embedded Excalidraw scene (export it with “Embed scene”)");
  return decodePayload(Buffer.from(match[1]!.replace(/\s+/g, ""), "base64").toString("latin1"));
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

export function isPng(bytes: Buffer): boolean {
  return bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
}

export function decodePngScene(bytes: Buffer): string {
  if (!isPng(bytes)) throw new PathError("Not a PNG file");
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "tEXt") {
      const separator = data.indexOf(0);
      if (separator > 0 && data.toString("latin1", 0, separator) === MIME) {
        return decodePayload(data.toString("latin1", separator + 1));
      }
    }
    if (type === "IEND") break;
    offset += 12 + length;
  }
  throw new PathError("This PNG has no embedded Excalidraw scene (export it with “Embed scene”)");
}

/** A valid, blank 400x200 white `.excalidraw.svg` that already carries `sceneText`. */
export function emptySvg(sceneText: string): string {
  const payload = Buffer.from(encodePayload(sceneText), "latin1").toString("base64");
  return (
    '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
    `<!-- svg-source:excalidraw --><metadata><!-- payload-type:${MIME} --><!-- payload-version:2 --><!-- payload-start -->${payload}<!-- payload-end --></metadata>` +
    '<rect x="0" y="0" width="400" height="200" fill="#ffffff"></rect></svg>\n'
  );
}

/** A valid 1x1 white `.excalidraw.png` that already carries `sceneText`. */
export function emptyPng(sceneText: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const pixel = deflateSync(Buffer.from([0, 255, 255, 255])); // filter byte + one white pixel
  const text = Buffer.concat([Buffer.from(`${MIME}\0`, "latin1"), Buffer.from(encodePayload(sceneText), "latin1")]);
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("tEXt", text), chunk("IDAT", pixel), chunk("IEND", Buffer.alloc(0))]);
}
