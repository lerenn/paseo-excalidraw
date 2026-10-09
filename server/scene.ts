import { randomBytes, randomInt } from "node:crypto";

/**
 * Server-side Excalidraw element builder. `convertToExcalidrawElements` cannot run in Node (the
 * package touches `window` on import), so this produces the subset of the format the tools need.
 * Text sizes are approximations; Excalidraw re-measures text when it loads the scene.
 */

export type Element = Record<string, any> & { id: string; type: string };
export interface Scene extends Record<string, unknown> {
  elements: Element[];
}

export class SceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneError";
  }
}

export type ShapeKind = "rectangle" | "ellipse" | "diamond";
export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";

const FONT_FAMILY_EXCALIFONT = 5;
const LINE_HEIGHT = 1.25;
const CHAR_WIDTH = 0.6;
const LABEL_PADDING = 16;

export function shortId(): string {
  return randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 6);
}

export function liveElements(scene: Scene): Element[] {
  return scene.elements.filter((element) => !element.isDeleted);
}

function touch(element: Element): void {
  element.version = (element.version ?? 0) + 1;
  element.versionNonce = randomInt(1, 2 ** 31 - 1);
  element.updated = Date.now();
}

// Fractional indexes (https://github.com/rocicorp/fractional-indexing), append-only subset.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function integerLength(head: string): number {
  return head >= "a" && head <= "z" ? head.charCodeAt(0) - 96 + 1 : 0;
}
function validIndex(index: unknown): index is string {
  if (typeof index !== "string" || index.length < 2) return false;
  const length = integerLength(index[0]!);
  if (length === 0 || index.length < length || index.endsWith("0") && index.length > length) return false;
  return [...index.slice(1)].every((char) => DIGITS.includes(char));
}
function indexAfter(last: string | null): string | null {
  if (last === null) return "a0";
  const length = integerLength(last[0]!);
  const integer = last.slice(0, length);
  const digits = integer.slice(1).split("");
  let position = digits.length - 1;
  while (position >= 0) {
    const next = DIGITS.indexOf(digits[position]!) + 1;
    if (next < DIGITS.length) {
      digits[position] = DIGITS[next]!;
      return integer[0] + digits.join("");
    }
    digits[position] = "0";
    position -= 1;
  }
  // Integer part overflowed: move to the next head with one more digit.
  const head = String.fromCharCode(integer.charCodeAt(0) + 1);
  if (head > "z") return null;
  return head + "0".repeat(integerLength(head) - 1);
}
function nextIndex(scene: Scene): string | null {
  let max: string | null = null;
  for (const element of scene.elements) {
    if (element.index !== undefined && element.index !== null && !validIndex(element.index)) return null;
    if (typeof element.index === "string" && (max === null || element.index > max)) max = element.index;
  }
  return indexAfter(max);
}

function baseElement(scene: Scene, type: string, x: number, y: number, width: number, height: number): Element {
  return {
    id: shortId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: nextIndex(scene),
    roundness: null,
    seed: randomInt(1, 2 ** 31 - 1),
    version: 1,
    versionNonce: randomInt(1, 2 ** 31 - 1),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = Math.max(1, ...lines.map((line) => line.length));
  return { width: Math.ceil(longest * fontSize * CHAR_WIDTH), height: Math.ceil(lines.length * fontSize * LINE_HEIGHT) };
}

function addBoundElement(element: Element, reference: { id: string; type: "text" | "arrow" }): void {
  element.boundElements = [...(element.boundElements ?? []).filter((bound: any) => bound.id !== reference.id), reference];
}

function makeText(
  scene: Scene,
  text: string,
  x: number,
  y: number,
  options: { fontSize?: number; color?: string; containerId?: string | null; centered?: boolean },
): Element {
  const fontSize = options.fontSize ?? 20;
  const size = measureText(text, fontSize);
  const element = baseElement(scene, "text", x, y, size.width, size.height);
  Object.assign(element, {
    strokeColor: options.color ?? "#1e1e1e",
    text,
    originalText: text,
    fontSize,
    fontFamily: FONT_FAMILY_EXCALIFONT,
    textAlign: options.centered ? "center" : "left",
    verticalAlign: options.containerId ? "middle" : "top",
    containerId: options.containerId ?? null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  });
  return element;
}

/** Centre a bound text element on its container (shape centre, or arrow midpoint). */
function placeBoundText(text: Element, container: Element): void {
  if (container.type === "arrow") {
    const points = arrowAbsolutePoints(container);
    const first = points[0]!;
    const last = points[points.length - 1]!;
    text.x = (first[0] + last[0]) / 2 - text.width / 2;
    text.y = (first[1] + last[1]) / 2 - text.height / 2;
  } else {
    text.x = container.x + (container.width - text.width) / 2;
    text.y = container.y + (container.height - text.height) / 2;
  }
}

function arrowAbsolutePoints(arrow: Element): [number, number][] {
  return (arrow.points as [number, number][]).map(([px, py]) => [arrow.x + px, arrow.y + py]);
}

export interface Placement {
  x?: number;
  y?: number;
}

/** Grid slot to the right of / below existing content so unplaced shapes do not stack. */
function autoPlace(scene: Scene, width: number, height: number): { x: number; y: number } {
  const shapes = liveElements(scene).filter((element) => element.type !== "text" || !element.containerId);
  if (shapes.length === 0) return { x: 0, y: 0 };
  const columns = 4;
  const gapX = 80;
  const gapY = 80;
  const minX = Math.min(...shapes.map((element) => element.x));
  const minY = Math.min(...shapes.map((element) => element.y));
  const maxX = Math.max(...shapes.map((element) => element.x + element.width));
  const maxY = Math.max(...shapes.map((element) => element.y + element.height));
  const count = shapes.filter((element) => element.type !== "arrow").length;
  const cellWidth = 160 + gapX;
  const cellHeight = 100 + gapY;
  const column = count % columns;
  const row = Math.floor(count / columns);
  const x = minX + column * cellWidth;
  const y = minY + row * cellHeight;
  // If the grid slot collides with existing content, fall back to below everything.
  const collides = shapes.some(
    (element) => x < element.x + element.width && x + width > element.x && y < element.y + element.height && y + height > element.y,
  );
  return collides ? { x: minX, y: maxY + gapY } : { x: Math.min(x, Math.max(minX, maxX)), y };
}

export interface ShapeInput extends Placement {
  kind: ShapeKind;
  label?: string;
  width?: number;
  height?: number;
  color?: string;
  background?: string;
  fontSize?: number;
}

export function addShape(scene: Scene, input: ShapeInput): Element {
  const fontSize = input.fontSize ?? 20;
  const labelSize = input.label ? measureText(input.label, fontSize) : null;
  // Diamonds and ellipses have less usable inner room than their bounding box.
  const factor = input.kind === "rectangle" ? 1 : 1.5;
  const minWidth = labelSize ? Math.ceil((labelSize.width + LABEL_PADDING * 2) * factor) : 0;
  const minHeight = labelSize ? Math.ceil((labelSize.height + LABEL_PADDING * 2) * factor) : 0;
  const width = Math.max(input.width ?? 160, minWidth);
  const height = Math.max(input.height ?? 80, minHeight);
  const position = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : autoPlace(scene, width, height);
  const shape = baseElement(scene, input.kind, input.x ?? position.x, input.y ?? position.y, width, height);
  shape.roundness = input.kind === "rectangle" ? { type: 3 } : input.kind === "diamond" ? { type: 2 } : null;
  if (input.color) shape.strokeColor = input.color;
  if (input.background) shape.backgroundColor = input.background;
  scene.elements.push(shape);
  if (input.label) {
    const text = makeText(scene, input.label, 0, 0, { fontSize, color: input.color, containerId: shape.id, centered: true });
    placeBoundText(text, shape);
    addBoundElement(shape, { id: text.id, type: "text" });
    scene.elements.push(text);
  }
  return shape;
}

export function addText(
  scene: Scene,
  input: Placement & { text: string; fontSize?: number; color?: string },
): Element {
  const size = measureText(input.text, input.fontSize ?? 20);
  const position = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : autoPlace(scene, size.width, size.height);
  const text = makeText(scene, input.text, input.x ?? position.x, input.y ?? position.y, input);
  scene.elements.push(text);
  return text;
}

/** Resolve an element by id, or by exact (case-insensitive) label/text when unambiguous. */
export function resolveRef(scene: Scene, ref: string): Element {
  const live = liveElements(scene);
  const byId = live.find((element) => element.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const matches = live.filter((element) => labelOf(scene, element)?.trim().toLowerCase() === wanted && element.type !== "text");
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new SceneError(`"${ref}" matches ${matches.length} elements (${matches.map((m) => m.id).join(", ")}); use an id`);
  const texts = live.filter((element) => element.type === "text" && !element.containerId && element.text?.trim().toLowerCase() === wanted);
  if (texts.length === 1) return texts[0]!;
  throw new SceneError(`No element with id or label "${ref}". Use read_diagram to list ids.`);
}

export function labelOf(scene: Scene, element: Element): string | null {
  if (element.type === "text") return element.text ?? null;
  const bound = (element.boundElements ?? []).find((reference: any) => reference.type === "text");
  if (!bound) return null;
  const text = scene.elements.find((candidate) => candidate.id === bound.id && !candidate.isDeleted);
  return text?.text ?? null;
}

/** Point where the ray from the shape's centre towards (tx, ty) leaves the shape. */
function boundaryPoint(shape: Element, tx: number, ty: number, gap: number): [number, number] {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  let dx = tx - cx;
  let dy = ty - cy;
  if (dx === 0 && dy === 0) dx = 1;
  const halfWidth = shape.width / 2 + gap;
  const halfHeight = shape.height / 2 + gap;
  let scale: number;
  if (shape.type === "ellipse") scale = 1 / Math.sqrt((dx / halfWidth) ** 2 + (dy / halfHeight) ** 2);
  else if (shape.type === "diamond") scale = 1 / (Math.abs(dx) / halfWidth + Math.abs(dy) / halfHeight);
  else scale = Math.min(dx !== 0 ? halfWidth / Math.abs(dx) : Infinity, dy !== 0 ? halfHeight / Math.abs(dy) : Infinity);
  return [cx + dx * scale, cy + dy * scale];
}

const BINDING_GAP = 6;

function isBindable(element: Element): boolean {
  return element.type === "rectangle" || element.type === "ellipse" || element.type === "diamond" || (element.type === "text" && !element.containerId);
}

/** Recompute an arrow's geometry from the two shapes it is bound to. */
function routeArrow(scene: Scene, arrow: Element): void {
  const start = arrow.startBinding ? scene.elements.find((e) => e.id === arrow.startBinding.elementId && !e.isDeleted) : undefined;
  const end = arrow.endBinding ? scene.elements.find((e) => e.id === arrow.endBinding.elementId && !e.isDeleted) : undefined;
  if (!start || !end) return;
  const startCenter: [number, number] = [start.x + start.width / 2, start.y + start.height / 2];
  const endCenter: [number, number] = [end.x + end.width / 2, end.y + end.height / 2];
  const from = boundaryPoint(start, endCenter[0], endCenter[1], BINDING_GAP);
  const to = boundaryPoint(end, startCenter[0], startCenter[1], BINDING_GAP);
  arrow.x = from[0];
  arrow.y = from[1];
  arrow.points = [[0, 0], [to[0] - from[0], to[1] - from[1]]];
  arrow.width = Math.abs(to[0] - from[0]);
  arrow.height = Math.abs(to[1] - from[1]);
  touch(arrow);
  for (const bound of arrow.boundElements ?? []) {
    const text = scene.elements.find((e) => e.id === bound.id && e.type === "text" && !e.isDeleted);
    if (text) {
      placeBoundText(text, arrow);
      touch(text);
    }
  }
}

export interface ConnectInput {
  from: string;
  to: string;
  label?: string;
  color?: string;
  style?: "solid" | "dashed" | "dotted";
  arrowhead?: "arrow" | "triangle" | "bar" | "none";
  bidirectional?: boolean;
}

export function connect(scene: Scene, input: ConnectInput): Element {
  const start = resolveRef(scene, input.from);
  const end = resolveRef(scene, input.to);
  if (!isBindable(start) || !isBindable(end)) throw new SceneError("Arrows can only connect shapes or free text, not other arrows");
  if (start.id === end.id) throw new SceneError("Cannot connect an element to itself");
  const arrow = baseElement(scene, "arrow", 0, 0, 0, 0);
  const head = input.arrowhead === "none" ? null : input.arrowhead ?? "arrow";
  Object.assign(arrow, {
    roundness: { type: 2 },
    points: [[0, 0], [1, 1]],
    lastCommittedPoint: null,
    startBinding: { elementId: start.id, focus: 0, gap: BINDING_GAP },
    endBinding: { elementId: end.id, focus: 0, gap: BINDING_GAP },
    startArrowhead: input.bidirectional ? head : null,
    endArrowhead: head,
    elbowed: false,
    strokeStyle: input.style ?? "solid",
  });
  if (input.color) arrow.strokeColor = input.color;
  scene.elements.push(arrow);
  addBoundElement(start, { id: arrow.id, type: "arrow" });
  addBoundElement(end, { id: arrow.id, type: "arrow" });
  touch(start);
  touch(end);
  if (input.label) {
    const text = makeText(scene, input.label, 0, 0, { fontSize: 16, color: input.color, containerId: arrow.id, centered: true });
    addBoundElement(arrow, { id: text.id, type: "text" });
    scene.elements.push(text);
  }
  routeArrow(scene, arrow);
  return arrow;
}

export interface UpdateInput {
  id: string;
  label?: string;
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  background?: string;
  fontSize?: number;
}

/** Re-flow arrows and bound text after shapes moved or resized. */
function reflow(scene: Scene, moved: Element[]): void {
  const ids = new Set(moved.map((element) => element.id));
  for (const element of moved) {
    for (const bound of element.boundElements ?? []) {
      const dependent = scene.elements.find((e) => e.id === bound.id && !e.isDeleted);
      if (!dependent) continue;
      if (dependent.type === "text") {
        placeBoundText(dependent, element);
        touch(dependent);
      }
    }
  }
  for (const arrow of scene.elements) {
    if (arrow.type !== "arrow" || arrow.isDeleted) continue;
    if (ids.has(arrow.startBinding?.elementId) || ids.has(arrow.endBinding?.elementId)) routeArrow(scene, arrow);
  }
}

export function updateElement(scene: Scene, input: UpdateInput): Element {
  const element = resolveRef(scene, input.id);
  const text = element.type === "text" ? element : scene.elements.find((e) => e.id === (element.boundElements ?? []).find((b: any) => b.type === "text")?.id && !e.isDeleted);
  if (element.type === "arrow" && (input.x !== undefined || input.y !== undefined || input.width !== undefined || input.height !== undefined)) {
    throw new SceneError("Arrows follow the shapes they connect; move the shapes instead");
  }
  if (input.x !== undefined) element.x = input.x;
  if (input.y !== undefined) element.y = input.y;
  if (input.color) element.strokeColor = input.color;
  if (input.background && element.type !== "text") element.backgroundColor = input.background;

  const newLabel = element.type === "text" ? input.text ?? input.label : input.label;
  if (element.type === "text") {
    if (newLabel !== undefined) {
      const fontSize = input.fontSize ?? element.fontSize;
      const size = measureText(newLabel, fontSize);
      Object.assign(element, { text: newLabel, originalText: newLabel, fontSize, width: size.width, height: size.height });
    } else if (input.fontSize) {
      const size = measureText(element.text, input.fontSize);
      Object.assign(element, { fontSize: input.fontSize, width: size.width, height: size.height });
    }
  } else if (newLabel !== undefined) {
    if (text && text.type === "text") {
      const size = measureText(newLabel, text.fontSize);
      Object.assign(text, { text: newLabel, originalText: newLabel, width: size.width, height: size.height });
      touch(text);
    } else if (newLabel !== "") {
      const created = makeText(scene, newLabel, 0, 0, { fontSize: element.type === "arrow" ? 16 : 20, containerId: element.id, centered: true });
      addBoundElement(element, { id: created.id, type: "text" });
      scene.elements.push(created);
    }
    if (element.type !== "arrow") {
      const label = labelOf(scene, element);
      if (label) {
        const size = measureText(label, 20);
        const factor = element.type === "rectangle" ? 1 : 1.5;
        element.width = Math.max(input.width ?? element.width, Math.ceil((size.width + LABEL_PADDING * 2) * factor));
        element.height = Math.max(input.height ?? element.height, Math.ceil((size.height + LABEL_PADDING * 2) * factor));
      }
    }
  }
  if (element.type !== "text" && element.type !== "arrow") {
    if (input.width !== undefined) element.width = input.width;
    if (input.height !== undefined) element.height = input.height;
  }
  touch(element);
  reflow(scene, [element]);
  return element;
}

export function deleteElements(scene: Scene, refs: string[]): string[] {
  const targets = refs.map((ref) => resolveRef(scene, ref));
  const removed = new Set<string>();
  function remove(element: Element): void {
    if (removed.has(element.id)) return;
    removed.add(element.id);
    element.isDeleted = true;
    touch(element);
    // Bound text goes with its container; arrows bound to a deleted shape go too.
    for (const bound of element.boundElements ?? []) {
      const dependent = scene.elements.find((e) => e.id === bound.id && !e.isDeleted);
      if (dependent) remove(dependent);
    }
    if (element.containerId) {
      const container = scene.elements.find((e) => e.id === element.containerId);
      if (container && !container.isDeleted) {
        container.boundElements = (container.boundElements ?? []).filter((b: any) => b.id !== element.id);
        touch(container);
      }
    }
    if (element.type === "arrow") {
      for (const binding of [element.startBinding, element.endBinding]) {
        const shape = binding && scene.elements.find((e) => e.id === binding.elementId);
        if (shape && !shape.isDeleted) {
          shape.boundElements = (shape.boundElements ?? []).filter((b: any) => b.id !== element.id);
          touch(shape);
        }
      }
    }
  }
  for (const target of targets) remove(target);
  return [...removed];
}

export function alignElements(
  scene: Scene,
  refs: string[],
  mode: AlignMode,
  distribute?: "horizontal" | "vertical",
): Element[] {
  const elements = refs.map((ref) => resolveRef(scene, ref)).filter((element) => element.type !== "arrow");
  if (elements.length < 2) throw new SceneError("Align needs at least two non-arrow elements");
  const left = Math.min(...elements.map((e) => e.x));
  const right = Math.max(...elements.map((e) => e.x + e.width));
  const top = Math.min(...elements.map((e) => e.y));
  const bottom = Math.max(...elements.map((e) => e.y + e.height));
  for (const element of elements) {
    if (mode === "left") element.x = left;
    else if (mode === "right") element.x = right - element.width;
    else if (mode === "center") element.x = (left + right) / 2 - element.width / 2;
    else if (mode === "top") element.y = top;
    else if (mode === "bottom") element.y = bottom - element.height;
    else element.y = (top + bottom) / 2 - element.height / 2;
  }
  if (distribute) {
    const horizontal = distribute === "horizontal";
    const sorted = [...elements].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    const size = (e: Element) => (horizontal ? e.width : e.height);
    const start = horizontal ? sorted[0]!.x : sorted[0]!.y;
    const last = sorted[sorted.length - 1]!;
    const end = (horizontal ? last.x : last.y) + size(last);
    const gap = (end - start - sorted.reduce((sum, e) => sum + size(e), 0)) / (sorted.length - 1);
    let cursor = start;
    for (const element of sorted) {
      if (horizontal) element.x = cursor;
      else element.y = cursor;
      cursor += size(element) + gap;
    }
  }
  for (const element of elements) touch(element);
  reflow(scene, elements);
  return elements;
}

const round = (value: number) => Math.round(value);

/** Compact text summary for small models: one line per element, ids first. */
export function summarize(scene: Scene): string {
  const live = liveElements(scene);
  const shapes = live.filter((e) => e.type !== "arrow" && !(e.type === "text" && e.containerId));
  const arrows = live.filter((e) => e.type === "arrow");
  if (live.length === 0) return "Empty diagram. Use add_shape / add_text to start.";
  const lines: string[] = [`${shapes.length} shapes/texts, ${arrows.length} arrows`];
  for (const element of shapes) {
    const label = labelOf(scene, element);
    const color = element.backgroundColor && element.backgroundColor !== "transparent" ? ` bg=${element.backgroundColor}` : "";
    lines.push(`${element.id} ${element.type}${label ? ` "${label.replace(/\n/g, "\\n")}"` : ""} at (${round(element.x)},${round(element.y)}) ${round(element.width)}x${round(element.height)}${color}`);
  }
  for (const arrow of arrows) {
    const name = (id?: string) => {
      const target = id ? scene.elements.find((e) => e.id === id) : undefined;
      return target ? labelOf(scene, target) ?? target.id : "?";
    };
    const label = labelOf(scene, arrow);
    lines.push(`${arrow.id} arrow ${arrow.startBinding ? `${arrow.startBinding.elementId}(${name(arrow.startBinding.elementId)})` : "free"} -> ${arrow.endBinding ? `${arrow.endBinding.elementId}(${name(arrow.endBinding.elementId)})` : "free"}${label ? ` "${label}"` : ""}`);
  }
  const box = live.filter((e) => e.type !== "arrow");
  if (box.length) {
    lines.push(
      `bounds: x ${round(Math.min(...box.map((e) => e.x)))}..${round(Math.max(...box.map((e) => e.x + e.width)))}, y ${round(Math.min(...box.map((e) => e.y)))}..${round(Math.max(...box.map((e) => e.y + e.height)))}`,
    );
  }
  return lines.join("\n");
}
