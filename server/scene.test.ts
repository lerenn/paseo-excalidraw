import { describe, expect, it } from "vitest";
import {
  SceneError,
  addShape,
  addText,
  alignElements,
  connect,
  deleteElements,
  labelOf,
  liveElements,
  resolveRef,
  summarize,
  updateElement,
  type Scene,
} from "./scene";

const empty = (): Scene => ({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
const byId = (scene: Scene, id: string) => scene.elements.find((e) => e.id === id)!;

/** Every binding must be mirrored by boundElements on the other side, and vice versa. */
function expectConsistent(scene: Scene) {
  for (const element of liveElements(scene)) {
    if (element.type === "arrow") {
      for (const binding of [element.startBinding, element.endBinding]) {
        if (!binding) continue;
        const target = byId(scene, binding.elementId);
        expect(target, "arrow bound to a missing element").toBeDefined();
        expect(target.isDeleted).toBe(false);
        expect(target.boundElements).toContainEqual({ id: element.id, type: "arrow" });
      }
    }
    if (element.type === "text" && element.containerId) {
      const container = byId(scene, element.containerId);
      expect(container.isDeleted).toBe(false);
      expect(container.boundElements).toContainEqual({ id: element.id, type: "text" });
    }
    for (const bound of element.boundElements ?? []) {
      const dependent = byId(scene, bound.id);
      expect(dependent, `${element.id} lists missing ${bound.id}`).toBeDefined();
      if (dependent.isDeleted) continue;
      if (bound.type === "text") expect(dependent.containerId).toBe(element.id);
      else expect([dependent.startBinding?.elementId, dependent.endBinding?.elementId]).toContain(element.id);
    }
  }
}

describe("shapes and text", () => {
  it("creates a labelled rectangle with a bound, centred text element", () => {
    const scene = empty();
    const shape = addShape(scene, { kind: "rectangle", label: "API", x: 100, y: 50 });
    const text = scene.elements.find((e) => e.type === "text")!;
    expect(text).toMatchObject({ text: "API", containerId: shape.id, textAlign: "center", verticalAlign: "middle", autoResize: true });
    expect(shape.boundElements).toEqual([{ id: text.id, type: "text" }]);
    expect(text.x + text.width / 2).toBeCloseTo(shape.x + shape.width / 2);
    expect(text.y + text.height / 2).toBeCloseTo(shape.y + shape.height / 2);
    expect(labelOf(scene, shape)).toBe("API");
    expectConsistent(scene);
  });

  it("grows the shape so a long label fits, more for ellipses and diamonds", () => {
    const rect = addShape(empty(), { kind: "rectangle", label: "A fairly long label here", x: 0, y: 0, width: 40, height: 20 });
    const ellipse = addShape(empty(), { kind: "ellipse", label: "A fairly long label here", x: 0, y: 0, width: 40, height: 20 });
    expect(rect.width).toBeGreaterThan(200);
    expect(ellipse.width).toBeGreaterThan(rect.width);
  });

  it("uses the right roundness and a unique id and valid fractional indexes", () => {
    const scene = empty();
    const a = addShape(scene, { kind: "rectangle", x: 0, y: 0 });
    const b = addShape(scene, { kind: "ellipse", x: 0, y: 0 });
    const c = addShape(scene, { kind: "diamond", x: 0, y: 0 });
    expect(a.roundness).toEqual({ type: 3 });
    expect(b.roundness).toBeNull();
    expect(c.roundness).toEqual({ type: 2 });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect([a.index, b.index, c.index]).toEqual(["a0", "a1", "a2"]);
  });

  it("keeps indexes ordered past the first 62 elements and falls back when existing ones are invalid", () => {
    const scene = empty();
    for (let i = 0; i < 70; i++) addText(scene, { text: String(i), x: 0, y: i * 30 });
    const indexes = scene.elements.map((e) => e.index as string);
    expect(indexes[61]).toBe("az");
    expect(indexes[62]).toBe("b00");
    expect([...indexes].sort()).toEqual(indexes);
    const odd: Scene = { ...empty(), elements: [{ id: "x", type: "rectangle", index: "not valid!" } as never] };
    expect(addText(odd, { text: "t", x: 0, y: 0 }).index).toBeNull();
  });

  it("auto-places unplaced shapes without overlap", () => {
    const scene = empty();
    const shapes = Array.from({ length: 9 }, (_, i) => addShape(scene, { kind: "rectangle", label: `n${i}` }));
    for (const [i, a] of shapes.entries()) {
      for (const b of shapes.slice(i + 1)) {
        const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });
});

describe("connect", () => {
  it("binds both ends, mirrors boundElements, and starts/ends on the shape borders", () => {
    const scene = empty();
    const a = addShape(scene, { kind: "rectangle", label: "A", x: 0, y: 0, width: 100, height: 60 });
    const b = addShape(scene, { kind: "rectangle", label: "B", x: 300, y: 0, width: 100, height: 60 });
    const arrow = connect(scene, { from: a.id, to: b.id, label: "calls" });
    expect(arrow.startBinding).toMatchObject({ elementId: a.id });
    expect(arrow.endBinding).toMatchObject({ elementId: b.id });
    expect(a.boundElements).toContainEqual({ id: arrow.id, type: "arrow" });
    expect(b.boundElements).toContainEqual({ id: arrow.id, type: "arrow" });
    // Horizontal arrow between facing edges, leaving a small gap.
    expect(arrow.x).toBeCloseTo(100 + 6);
    expect(arrow.x + arrow.points[1][0]).toBeCloseTo(300 - 6);
    expect(arrow.y).toBeCloseTo(30);
    expect(arrow.endArrowhead).toBe("arrow");
    const label = byId(scene, arrow.boundElements.find((x: any) => x.type === "text").id);
    expect(label).toMatchObject({ text: "calls", containerId: arrow.id });
    expect(label.x + label.width / 2).toBeCloseTo(200);
    expectConsistent(scene);
  });

  it("resolves endpoints by label and reports ambiguity or unknown names", () => {
    const scene = empty();
    addShape(scene, { kind: "rectangle", label: "Web", x: 0, y: 0 });
    addShape(scene, { kind: "rectangle", label: "DB", x: 300, y: 0 });
    addShape(scene, { kind: "ellipse", label: "DB", x: 600, y: 0 });
    expect(() => connect(scene, { from: "web", to: "DB" })).toThrow(/matches 2 elements/);
    expect(() => connect(scene, { from: "web", to: "nope" })).toThrow(SceneError);
    const arrow = connect(scene, { from: "Web", to: scene.elements.find((e) => e.type === "ellipse")!.id });
    expect(arrow.type).toBe("arrow");
  });

  it("rejects self-connections and arrows as endpoints", () => {
    const scene = empty();
    const a = addShape(scene, { kind: "rectangle", x: 0, y: 0 });
    const b = addShape(scene, { kind: "rectangle", x: 300, y: 0 });
    expect(() => connect(scene, { from: a.id, to: a.id })).toThrow(/itself/);
    const arrow = connect(scene, { from: a.id, to: b.id });
    expect(() => connect(scene, { from: arrow.id, to: b.id })).toThrow(/not other arrows/);
  });

  it("starts on the ellipse and diamond outline, not the bounding box corner", () => {
    const scene = empty();
    const e = addShape(scene, { kind: "ellipse", x: 0, y: 0, width: 100, height: 100 });
    const d = addShape(scene, { kind: "diamond", x: 200, y: 200, width: 100, height: 100 });
    const arrow = connect(scene, { from: e.id, to: d.id });
    const endX = arrow.x + arrow.points[1][0];
    const endY = arrow.y + arrow.points[1][1];
    const radius = Math.hypot(arrow.x - 50, arrow.y - 50);
    expect(radius).toBeCloseTo(50 + 6, 0);
    // Diamond boundary: |dx|/50 + |dy|/50 = 1 (+gap) around centre (250,250).
    expect(Math.abs(endX - 250) / 56 + Math.abs(endY - 250) / 56).toBeCloseTo(1, 1);
  });
});

describe("update, move, align, delete", () => {
  it("moving a shape re-routes its arrows and re-centres labels, bumping versions", () => {
    const scene = empty();
    const a = addShape(scene, { kind: "rectangle", label: "A", x: 0, y: 0, width: 100, height: 60 });
    const b = addShape(scene, { kind: "rectangle", label: "B", x: 300, y: 0, width: 100, height: 60 });
    const arrow = connect(scene, { from: a.id, to: b.id, label: "x" });
    const arrowVersion = arrow.version;
    const bVersion = b.version;
    updateElement(scene, { id: b.id, x: 300, y: 300 });
    expect(arrow.version).toBeGreaterThan(arrowVersion);
    expect(b.version).toBeGreaterThan(bVersion);
    expect(arrow.points[1][1]).toBeGreaterThan(100);
    const text = byId(scene, b.boundElements.find((x: any) => x.type === "text").id);
    expect(text.y + text.height / 2).toBeCloseTo(300 + 30);
    expectConsistent(scene);
  });

  it("changes label, colours and size; creates a label if there was none", () => {
    const scene = empty();
    const shape = addShape(scene, { kind: "rectangle", x: 0, y: 0 });
    updateElement(scene, { id: shape.id, label: "Hello", color: "#e03131", background: "#ffc9c9" });
    expect(labelOf(scene, shape)).toBe("Hello");
    expect(shape).toMatchObject({ strokeColor: "#e03131", backgroundColor: "#ffc9c9" });
    updateElement(scene, { id: shape.id, label: "Renamed" });
    expect(labelOf(scene, shape)).toBe("Renamed");
    expect(liveElements(scene).filter((e) => e.type === "text")).toHaveLength(1);
    expectConsistent(scene);
  });

  it("refuses to move arrows directly", () => {
    const scene = empty();
    const a = addShape(scene, { kind: "rectangle", x: 0, y: 0 });
    const b = addShape(scene, { kind: "rectangle", x: 300, y: 0 });
    const arrow = connect(scene, { from: a.id, to: b.id });
    expect(() => updateElement(scene, { id: arrow.id, x: 5 })).toThrow(/follow the shapes/);
  });

  it("deleting a shape tombstones it with its label and arrows, and unbinds the other end", () => {
    const scene = empty();
    const a = addShape(scene, { kind: "rectangle", label: "A", x: 0, y: 0 });
    const b = addShape(scene, { kind: "rectangle", label: "B", x: 300, y: 0 });
    const c = addShape(scene, { kind: "rectangle", label: "C", x: 600, y: 0 });
    const ab = connect(scene, { from: a.id, to: b.id, label: "ab" });
    const bc = connect(scene, { from: b.id, to: c.id });
    const removed = deleteElements(scene, [b.id]);
    expect(removed).toEqual(expect.arrayContaining([b.id, ab.id, bc.id]));
    expect(ab.isDeleted && bc.isDeleted && b.isDeleted).toBe(true);
    // Tombstones stay in the scene so other clients can merge the deletion.
    expect(scene.elements.find((e) => e.id === b.id)).toBeDefined();
    expect(a.boundElements).toEqual([{ id: scene.elements.find((e) => e.containerId === a.id)!.id, type: "text" }]);
    expect(c.boundElements?.some((x: any) => x.type === "arrow")).toBe(false);
    expect(liveElements(scene).map((e) => labelOf(scene, e)).filter(Boolean).sort()).toEqual(["A", "A", "C", "C"]);
    expectConsistent(scene);
  });

  it("aligns and distributes, then re-routes arrows", () => {
    const scene = empty();
    const a = addShape(scene, { kind: "rectangle", x: 0, y: 0, width: 100, height: 60 });
    const b = addShape(scene, { kind: "rectangle", x: 150, y: 90, width: 100, height: 60 });
    const c = addShape(scene, { kind: "rectangle", x: 700, y: 40, width: 100, height: 60 });
    const arrow = connect(scene, { from: a.id, to: b.id });
    alignElements(scene, [a.id, b.id, c.id], "top", "horizontal");
    expect([a.y, b.y, c.y]).toEqual([0, 0, 0]);
    expect(b.x).toBeCloseTo(350);
    expect(arrow.points[1][1]).toBeCloseTo(0);
    expectConsistent(scene);
    expect(() => alignElements(scene, [a.id], "left")).toThrow(/at least two/);
  });
});

describe("summary", () => {
  it("lists ids, labels, positions and connections compactly", () => {
    const scene = empty();
    const a = addShape(scene, { kind: "rectangle", label: "Auth", x: 0, y: 0, width: 160, height: 80, background: "#a5d8ff" });
    const b = addShape(scene, { kind: "ellipse", label: "DB", x: 300, y: 0 });
    connect(scene, { from: a.id, to: b.id, label: "reads" });
    const text = summarize(scene);
    expect(text).toContain(`${a.id} rectangle "Auth" at (0,0) 160x80 bg=#a5d8ff`);
    expect(text).toContain(`${a.id}(Auth) -> ${b.id}(DB) "reads"`);
    expect(text).toMatch(/^2 shapes\/texts, 1 arrows/);
    expect(text.split("\n").length).toBeLessThan(10);
    expect(summarize(empty())).toMatch(/Empty diagram/);
    expect(resolveRef(scene, "auth").id).toBe(a.id);
  });
});
