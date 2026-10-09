import "./offline-fonts";
import {
  Excalidraw,
  exportToBlob,
  exportToSvg,
  getSceneVersion,
  loadFromBlob,
  reconcileElements,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import excalidrawCss from "@excalidraw/excalidraw/index.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FromRuntime, ToRuntime } from "../shared/runtime-protocol";

// Types are intentionally loose: this file runs in the iframe and is built outside the plugin compiler.
type Api = {
  getSceneElementsIncludingDeleted(): readonly any[];
  getAppState(): any;
  getFiles(): any;
  updateScene(data: any): void;
  scrollToContent(target?: readonly any[], opts?: { fitToViewport?: boolean; viewportZoomFactor?: number; animate?: boolean }): void;
  addFiles(files: any[]): void;
  updateLibrary?: unknown;
};

const style = document.createElement("style");
style.textContent = excalidrawCss + "\nhtml,body,#root{height:100%;margin:0;overflow:hidden}";
document.head.appendChild(style);

function post(message: FromRuntime) {
  window.parent.postMessage(message, "*");
}

type Format = "json" | "svg" | "png";
type Parsed = { elements: any[]; files: any; appState: any };

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function parseScene(text: string, format: Format): Promise<Parsed> {
  if (format !== "json") {
    // Exported images carry the scene; Excalidraw's own loader reads it back out.
    const blob =
      format === "svg"
        ? new Blob([text], { type: "image/svg+xml" })
        : new Blob([base64ToBytes(text)], { type: "image/png" });
    const loaded = await loadFromBlob(blob, null, null);
    return { elements: [...loaded.elements] as any[], files: loaded.files ?? {}, appState: loaded.appState ?? {} };
  }
  const data = JSON.parse(text || "{}");
  return {
    // No refreshDimensions here: the fonts are not loaded yet, so measuring now would use a
    // fallback font and clip text. remeasure() does it once the real fonts are available.
    elements: restoreElements(Array.isArray(data.elements) ? data.elements : [], null, {
      repairBindings: true,
    }) as any[],
    files: data.files ?? {},
    appState: data.appState ?? {},
  };
}

const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// serializeAsJSON("local") drops deleted elements and ("database") drops files. The JSON file must keep
// tombstones so a deletion merges with concurrent edits, so assemble the scene from both. Image
// formats (svg, png) can only embed live elements, so deletions there carry no tombstone.
async function serializeScene(elements: readonly any[], appState: any, files: any): Promise<string> {
  if (format === "json") {
    const local = JSON.parse(serializeAsJSON(elements as never, appState, files, "local"));
    const now = Date.now();
    local.elements = elements.filter((e) => !e.isDeleted || now - (e.updated ?? 0) < TOMBSTONE_TTL_MS);
    return JSON.stringify(local, null, 2);
  }
  const live = elements.filter((e) => !e.isDeleted);
  const exportState = { ...appState, exportEmbedScene: true, exportBackground: true, exportWithDarkMode: false };
  if (format === "svg") {
    const svg = await exportToSvg({ elements: live, appState: exportState, files, exportPadding: 20 } as never);
    return svg.outerHTML;
  }
  const blob = await exportToBlob({ elements: live, appState: exportState, files, mimeType: "image/png", exportPadding: 20 } as never);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

let api: Api | null = null;
let theme: "light" | "dark" = "light";
let readOnly = false;
let fitted = false;
let format: Format = "json";
let lastSentVersion = -1;
let suppressChange = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let initial: Parsed | null = null;
const root = createRoot(document.getElementById("root")!);

function render() {
  root.render(
    createElement(Excalidraw as any, {
      excalidrawAPI: (value: Api) => {
        api = value;
      },
      initialData: initial
        ? {
            elements: initial.elements,
            files: initial.files,
            appState: {
              viewBackgroundColor: initial.appState.viewBackgroundColor ?? "#ffffff",
              gridSize: initial.appState.gridSize ?? null,
            },
          }
        : undefined,
      theme,
      viewModeEnabled: readOnly,
      langCode: "en",
      UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false } },
      onChange: (elements: readonly any[]) => {
        // Excalidraw centres initial content but does not zoom, so a big diagram would open cut
        // off. Fit it once per load, after the first change event (scene and canvas size known).
        if (!fitted && api && elements.some((element) => !element.isDeleted)) {
          fitted = true;
          const target = elements.filter((element) => !element.isDeleted);
          requestAnimationFrame(() =>
            api?.scrollToContent(target, { fitToViewport: true, viewportZoomFactor: 0.9, animate: false }),
          );
        }
        if (suppressChange) return;
        const version = getSceneVersion(elements as never);
        if (version === lastSentVersion) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void emitChanged(), format === "json" ? 350 : 1200);
      },
    }),
  );
}

// Text written by tools has approximate sizes. Once a font has loaded, re-measure text with it so
// boxes fit exactly. Idempotent, and only touches the live scene when a size actually changes.
function remeasure() {
  if (!api) return;
  const current = api.getSceneElementsIncludingDeleted();
  if (!current.some((element) => element.type === "text" && !element.isDeleted)) return;
  const fixed = restoreElements(current as never, null, { refreshDimensions: true, repairBindings: true }) as any[];
  const changed =
    fixed.length !== current.length ||
    fixed.some((element, i) => element.width !== current[i]!.width || element.height !== current[i]!.height);
  if (!changed) return;
  suppressChange = true;
  api.updateScene({ elements: fixed });
  setTimeout(() => (suppressChange = false), 0);
}
document.fonts.addEventListener("loadingdone", () => setTimeout(remeasure, 30));

async function emitChanged() {
  timer = null;
  if (!api) return;
  const elements = api.getSceneElementsIncludingDeleted();
  lastSentVersion = getSceneVersion(elements as never);
  try {
    post({ type: "changed", scene: await serializeScene(elements, api.getAppState(), api.getFiles()) });
  } catch (error) {
    post({ type: "error", message: `Could not export the diagram: ${String(error)}` });
  }
}

async function applyRemote(text: string) {
  if (!api) return;
  const remote = await parseScene(text, format);
  if (!api) return;
  const local = api.getSceneElementsIncludingDeleted();
  const merged = reconcileElements(local as never, remote.elements as never, api.getAppState());
  const files = Object.values(remote.files ?? {}) as any[];
  if (files.length) api.addFiles(files);
  suppressChange = true;
  api.updateScene({ elements: merged });
  lastSentVersion = getSceneVersion(merged as never);
  // Release after Excalidraw delivers the onChange for this update.
  setTimeout(() => (suppressChange = false), 0);
  // If merging produced content the file lacks (local edits), persist it.
  if (JSON.stringify(merged.map((e: any) => [e.id, e.version])) !==
      JSON.stringify(remote.elements.map((e: any) => [e.id, e.version]))) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void emitChanged(), 100);
  }
}

// Hand-rolled shape check: bundling zod here would add ~450 KB. Mirrors shared/runtime-protocol.ts.
const isFormat = (value: unknown) => value === "json" || value === "svg" || value === "png";

function asToRuntime(data: unknown): ToRuntime | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  const themeOk = m.theme === "light" || m.theme === "dark";
  switch (m.type) {
    case "load":
      return typeof m.scene === "string" && themeOk && isFormat(m.format) ? (m as unknown as ToRuntime) : null;
    case "remote":
      return typeof m.scene === "string" && isFormat(m.format) ? (m as unknown as ToRuntime) : null;
    case "theme":
      return themeOk ? (m as unknown as ToRuntime) : null;
    default:
      return null;
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== window.parent) return;
  const message = asToRuntime(event.data);
  if (!message) return;
  try {
    switch (message.type) {
      case "load":
        theme = message.theme;
        readOnly = message.readOnly ?? false;
        format = message.format;
        initial = await parseScene(message.scene, format);
        fitted = false;
        lastSentVersion = getSceneVersion(initial.elements as never);
        render();
        break;
      case "remote":
        format = message.format;
        await applyRemote(message.scene);
        break;
      case "theme":
        theme = message.theme;
        render();
        break;
    }
  } catch (error) {
    post({ type: "error", message: String(error) });
  }
});

window.addEventListener("error", (e) => post({ type: "error", message: String(e.message) }));
post({ type: "ready" });
