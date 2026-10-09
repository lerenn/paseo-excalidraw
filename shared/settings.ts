import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Last diagram opened per workspace, so the panel reopens where you left off. */
export const diagramSettings = defineSettings({
  id: "diagrams",
  scope: "host",
  version: 1,
  schema: z.object({ lastFile: z.record(z.string(), z.string()).default({}) }),
});
