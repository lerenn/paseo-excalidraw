import { z } from "zod";

export const formatSchema = z.enum(["json", "svg", "png"]);

export const colorSchemeSchema = z.enum(["light", "dark"]);

/** Messages the panel (parent window) sends to the Excalidraw iframe. */
export const toRuntimeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("load"),
    /** Scene JSON, an SVG document, or a base64 PNG, depending on `format`. */
    scene: z.string(),
    format: formatSchema,
    theme: colorSchemeSchema,
    readOnly: z.boolean().optional(),
  }),
  z.object({ type: z.literal("remote"), scene: z.string(), format: formatSchema }),
  z.object({ type: z.literal("theme"), theme: colorSchemeSchema }),
]);
export type ToRuntime = z.infer<typeof toRuntimeSchema>;

/** Messages the Excalidraw iframe sends to the panel. */
export const fromRuntimeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("changed"), scene: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type FromRuntime = z.infer<typeof fromRuntimeSchema>;
