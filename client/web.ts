import { Linking, Platform } from "react-native";
import { fromRuntimeSchema, type FromRuntime, type ToRuntime } from "../shared/runtime-protocol";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface FrameElement {
  style: Record<string, string>;
  srcdoc: string;
  title: string;
  setAttribute(name: string, value: string): void;
  remove(): void;
  contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}
interface MessageEventLike {
  source: unknown;
  data: unknown;
}
declare const window: {
  open(url: string, target: string, features: string): unknown;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
};
declare const document: { createElement(tag: "iframe"): FrameElement };
declare function atob(data: string): string;
declare class Blob {
  constructor(parts: unknown[]);
  stream(): { pipeThrough(transform: unknown): unknown };
}
declare class DecompressionStream {
  constructor(format: "gzip");
}
declare class Response {
  constructor(body: unknown);
  text(): Promise<string>;
}

export const isWeb = Platform.OS === "web";

export async function openExternal(url: string): Promise<void> {
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Linking.openURL(url);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The runtime is ~3 MB; fetch it once per page load per content hash.
let runtimeCache: { hash: string; html: Promise<string> } | null = null;

export interface RuntimeSource {
  info(): Promise<{ hash: string; chunks: number }>;
  chunk(hash: string, index: number): Promise<string>;
}

/** The Excalidraw iframe document, gunzipped. Cached by content hash; never touched on native. */
export async function loadRuntimeHtml(source: RuntimeSource): Promise<string> {
  if (Platform.OS !== "web") throw new Error("Excalidraw runs in the web and desktop apps only");
  const { hash, chunks } = await source.info();
  if (runtimeCache?.hash === hash) return runtimeCache.html;
  const html = (async () => {
    const parts = await Promise.all(
      Array.from({ length: chunks }, async (_, index) => base64ToBytes(await source.chunk(hash, index))),
    );
    const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  })();
  runtimeCache = { hash, html };
  html.catch(() => {
    if (runtimeCache?.html === html) runtimeCache = null;
  });
  return html;
}

export interface DiagramFrame {
  send(message: ToRuntime): void;
  destroy(): void;
}

/**
 * Mount the Excalidraw runtime in a sandboxed iframe inside `host` (the DOM node behind a React
 * Native Web View). The iframe has an opaque origin, its own React and its own CSS, so nothing
 * leaks into or out of the app. Only messages from that iframe's window, matching the protocol
 * schema, reach `onMessage`.
 */
export function mountDiagramFrame(
  host: unknown,
  html: string,
  onMessage: (message: FromRuntime) => void,
): DiagramFrame {
  if (Platform.OS !== "web") throw new Error("Excalidraw runs in the web and desktop apps only");
  const frame = document.createElement("iframe");
  frame.title = "Excalidraw";
  frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals");
  frame.setAttribute("allow", "clipboard-read; clipboard-write");
  Object.assign(frame.style, { width: "100%", height: "100%", border: "0", display: "block", background: "transparent" });
  frame.srcdoc = html;
  const listener = (event: MessageEventLike) => {
    if (event.source !== frame.contentWindow) return;
    const parsed = fromRuntimeSchema.safeParse(event.data);
    if (parsed.success) onMessage(parsed.data);
  };
  window.addEventListener("message", listener);
  (host as { appendChild(child: FrameElement): void }).appendChild(frame);
  return {
    send(message) {
      // The frame's origin is opaque, so "*" is the only target; the payload is the user's own scene.
      frame.contentWindow?.postMessage(message, "*");
    },
    destroy() {
      window.removeEventListener("message", listener);
      frame.remove();
    },
  };
}
