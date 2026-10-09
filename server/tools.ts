import path from "node:path";
import { z } from "zod";
import { backgroundColor, strokeColor } from "./colors";
import { withDiagramExtension } from "../shared/formats";
import { PathError } from "./paths";
import { createDiagram, listDiagrams, mutateDiagram, readDiagramScene } from "./files";
import {
  addShape,
  addText,
  alignElements,
  connect,
  deleteElements,
  labelOf,
  liveElements,
  summarize,
  updateElement,
  type Element,
  type Scene,
} from "./scene";

/** What a tool runs against: the agent's working directory. Paths never leave it. */
export interface ToolContext {
  root: string;
}

export interface Tool<Schema extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: Schema;
  run(args: z.output<Schema>, context: ToolContext): Promise<string>;
}

function define<Schema extends z.ZodObject>(tool: Tool<Schema>): Tool {
  return tool as unknown as Tool;
}

const diagramPath = z
  .string()
  .min(1)
  .describe(
    'Diagram file, relative to the project, e.g. "docs/architecture.excalidraw" (".excalidraw" is added if missing). Files ending in .excalidraw.svg or .excalidraw.png can be listed and read but only edited by the user in the Paseo panel.',
  );
const colorField = z.string().optional().describe('Stroke/text color: a name (red, blue, green, orange, purple, gray, black) or hex like "#1971c2"');
const backgroundField = z.string().optional().describe('Fill color: a name (red, blue, green, yellow, orange, purple, gray, transparent) or hex');
const position = {
  x: z.number().optional().describe("Left edge. Omit x and y to place automatically in free space"),
  y: z.number().optional().describe("Top edge"),
};

/** Accept relative paths, or absolute paths that are inside the project. */
export function normalizeDiagramPath(root: string, input: string): string {
  let relative = input.trim();
  if (path.isAbsolute(relative)) {
    const inside = path.relative(root, relative);
    if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      throw new PathError("Path is outside the project");
    }
    relative = inside;
  }
  return withDiagramExtension(relative);
}

async function edit(
  context: ToolContext,
  rawPath: string,
  change: (scene: Scene) => string,
): Promise<string> {
  const relative = normalizeDiagramPath(context.root, rawPath);
  const { result } = await mutateDiagram(context.root, relative, (scene) => {
    scene.elements = Array.isArray(scene.elements) ? scene.elements : [];
    return change(scene as Scene);
  });
  return result;
}

const describeShape = (scene: Scene, element: Element) => {
  const label = labelOf(scene, element);
  return `${element.id} ${element.type}${label ? ` "${label}"` : ""} at (${Math.round(element.x)},${Math.round(element.y)}) ${Math.round(element.width)}x${Math.round(element.height)}`;
};

export const tools: Tool[] = [
  define({
    name: "list_diagrams",
    description: "List the Excalidraw diagrams (.excalidraw, .excalidraw.svg, .excalidraw.png files) in the project, newest first.",
    schema: z.object({}),
    async run(_args, context) {
      const { files, truncated } = await listDiagrams(context.root);
      if (files.length === 0) return "No diagrams yet. Use create_diagram.";
      return [...files.map((file) => `${file.path} (${Math.max(1, Math.round(file.size / 1024))} KB)`), truncated ? "…more not shown" : ""]
        .filter(Boolean)
        .join("\n");
    },
  }),
  define({
    name: "read_diagram",
    description:
      "Compact summary of a diagram: one line per shape with its id, label, position and size, and one line per arrow. Use the ids with the other tools.",
    schema: z.object({ path: diagramPath }),
    async run({ path: file }, context) {
      const scene = await readDiagramScene(context.root, normalizeDiagramPath(context.root, file));
      return summarize(JSON.parse(scene) as Scene);
    },
  }),
  define({
    name: "create_diagram",
    description: "Create a new empty diagram file. Fails if it already exists. Prefer the plain .excalidraw format: agents can edit it, while .excalidraw.svg / .excalidraw.png can only be edited in the panel.",
    schema: z.object({ path: diagramPath }),
    async run({ path: file }, context) {
      const created = await createDiagram(context.root, normalizeDiagramPath(context.root, file));
      return `Created ${created.path}. Add content with add_shape, add_text or build_diagram.`;
    },
  }),
  define({
    name: "add_shape",
    description: "Add a rectangle, ellipse or diamond, optionally with a centered text label. Returns its id.",
    schema: z.object({
      path: diagramPath,
      kind: z.enum(["rectangle", "ellipse", "diamond"]),
      label: z.string().max(500).optional().describe("Text shown inside the shape"),
      ...position,
      width: z.number().positive().max(5000).optional(),
      height: z.number().positive().max(5000).optional(),
      color: colorField,
      background: backgroundField,
    }),
    async run(args, context) {
      return edit(context, args.path, (scene) => {
        const shape = addShape(scene, {
          kind: args.kind,
          label: args.label,
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          color: args.color ? strokeColor(args.color) : undefined,
          background: args.background ? backgroundColor(args.background) : undefined,
        });
        return `Added ${describeShape(scene, shape)}`;
      });
    },
  }),
  define({
    name: "add_text",
    description: "Add free-standing text (not inside a shape). Returns its id.",
    schema: z.object({
      path: diagramPath,
      text: z.string().min(1).max(2000),
      ...position,
      fontSize: z.number().min(8).max(100).optional().describe("Default 20"),
      color: colorField,
    }),
    async run(args, context) {
      return edit(context, args.path, (scene) => {
        const text = addText(scene, { text: args.text, x: args.x, y: args.y, fontSize: args.fontSize, color: args.color ? strokeColor(args.color) : undefined });
        return `Added ${describeShape(scene, text)}`;
      });
    },
  }),
  define({
    name: "connect",
    description:
      "Draw an arrow between two shapes. `from` and `to` are element ids, or an exact label if it is unique. The arrow stays attached when the shapes move.",
    schema: z.object({
      path: diagramPath,
      from: z.string().min(1),
      to: z.string().min(1),
      label: z.string().max(200).optional().describe("Text on the arrow"),
      style: z.enum(["solid", "dashed", "dotted"]).optional(),
      arrowhead: z.enum(["arrow", "triangle", "bar", "none"]).optional().describe('Default "arrow" at the end'),
      bidirectional: z.boolean().optional().describe("Also put an arrowhead at the start"),
      color: colorField,
    }),
    async run(args, context) {
      return edit(context, args.path, (scene) => {
        const arrow = connect(scene, {
          from: args.from,
          to: args.to,
          label: args.label,
          style: args.style,
          arrowhead: args.arrowhead,
          bidirectional: args.bidirectional,
          color: args.color ? strokeColor(args.color) : undefined,
        });
        return `Added arrow ${arrow.id}: ${arrow.startBinding.elementId} -> ${arrow.endBinding.elementId}`;
      });
    },
  }),
  define({
    name: "update",
    description:
      "Change an existing element: its label (or text), position, size, colors. Only the fields you pass change. Arrows follow their shapes, so move the shapes.",
    schema: z.object({
      path: diagramPath,
      id: z.string().min(1).describe("Element id (or unique label)"),
      label: z.string().max(500).optional().describe("New label for a shape or arrow; for free text use `text`"),
      text: z.string().max(2000).optional().describe("New content of a free text element"),
      ...position,
      width: z.number().positive().max(5000).optional(),
      height: z.number().positive().max(5000).optional(),
      fontSize: z.number().min(8).max(100).optional(),
      color: colorField,
      background: backgroundField,
    }),
    async run(args, context) {
      return edit(context, args.path, (scene) => {
        const element = updateElement(scene, {
          id: args.id,
          label: args.label,
          text: args.text,
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          fontSize: args.fontSize,
          color: args.color ? strokeColor(args.color) : undefined,
          background: args.background ? backgroundColor(args.background) : undefined,
        });
        return `Updated ${describeShape(scene, element)}`;
      });
    },
  }),
  define({
    name: "delete",
    description: "Delete elements by id (or unique label). Their labels and any arrows attached to them are deleted too.",
    schema: z.object({ path: diagramPath, ids: z.array(z.string().min(1)).min(1).max(100) }),
    async run(args, context) {
      return edit(context, args.path, (scene) => {
        const removed = deleteElements(scene, args.ids);
        return `Deleted ${removed.length} element(s): ${removed.join(", ")}`;
      });
    },
  }),
  define({
    name: "align",
    description: "Align shapes to a common edge or center, and optionally space them evenly. Attached arrows are re-routed.",
    schema: z.object({
      path: diagramPath,
      ids: z.array(z.string().min(1)).min(2).max(100),
      mode: z.enum(["left", "center", "right", "top", "middle", "bottom"]),
      distribute: z.enum(["horizontal", "vertical"]).optional().describe("Also space the shapes evenly along this axis"),
    }),
    async run(args, context) {
      return edit(context, args.path, (scene) => {
        const moved = alignElements(scene, args.ids, args.mode, args.distribute);
        return `Aligned ${moved.length} element(s) (${args.mode}${args.distribute ? `, distributed ${args.distribute}` : ""})`;
      });
    },
  }),
  define({
    name: "build_diagram",
    description:
      "Add many shapes and arrows in one call, laid out automatically left to right by their connections. Efficient for a whole flowchart or architecture diagram. Refer to nodes by their `key` in edges.",
    schema: z.object({
      path: diagramPath,
      nodes: z
        .array(
          z.object({
            key: z.string().min(1).describe("Short name used in edges"),
            label: z.string().max(500).optional().describe("Defaults to the key"),
            kind: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
            color: colorField,
            background: backgroundField,
          }),
        )
        .min(1)
        .max(60),
      edges: z
        .array(z.object({ from: z.string(), to: z.string(), label: z.string().max(200).optional() }))
        .max(200)
        .optional(),
    }),
    async run(args, context) {
      return edit(context, args.path, (scene) => {
        const keys = new Set(args.nodes.map((node) => node.key));
        if (keys.size !== args.nodes.length) throw new PathError("Node keys must be unique");
        for (const edge of args.edges ?? []) {
          if (!keys.has(edge.from) || !keys.has(edge.to)) throw new PathError(`Edge ${edge.from} -> ${edge.to} refers to an unknown node key`);
        }
        // Layered layout: column = longest path from a root, row = order within the column.
        const depth = new Map<string, number>(args.nodes.map((node) => [node.key, 0]));
        for (let pass = 0; pass < args.nodes.length; pass++) {
          let changed = false;
          for (const edge of args.edges ?? []) {
            const next = (depth.get(edge.from) ?? 0) + 1;
            if (next > (depth.get(edge.to) ?? 0) && next < args.nodes.length) {
              depth.set(edge.to, next);
              changed = true;
            }
          }
          if (!changed) break;
        }
        const live = liveElements(scene).filter((element) => element.type !== "arrow");
        const originY = live.length ? Math.max(...live.map((element) => element.y + element.height)) + 100 : 0;
        const rows = new Map<number, number>();
        const ids = new Map<string, string>();
        const lines: string[] = [];
        for (const node of args.nodes) {
          const column = depth.get(node.key) ?? 0;
          const row = rows.get(column) ?? 0;
          rows.set(column, row + 1);
          const shape = addShape(scene, {
            kind: node.kind ?? "rectangle",
            label: node.label ?? node.key,
            x: column * 280,
            y: originY + row * 140,
            color: node.color ? strokeColor(node.color) : undefined,
            background: node.background ? backgroundColor(node.background) : undefined,
          });
          ids.set(node.key, shape.id);
          lines.push(`${node.key} = ${shape.id}`);
        }
        for (const edge of args.edges ?? []) {
          connect(scene, { from: ids.get(edge.from)!, to: ids.get(edge.to)!, label: edge.label });
        }
        return `Added ${args.nodes.length} shapes and ${(args.edges ?? []).length} arrows. Ids: ${lines.join(", ")}`;
      });
    },
  }),
];
