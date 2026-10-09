import { FONTS } from "./fonts.gen";

// Excalidraw builds font URLs from window.EXCALIDRAW_ASSET_PATH and loads them two ways: the browser
// fetches FontFace sources itself, and Excalidraw calls fetch() when it needs the bytes (export,
// subsetting). The fonts are embedded in this document, so serve both from memory and never touch
// the network. Must be imported before Excalidraw so it is in place when fonts are registered.
export const FAKE_ASSET_ORIGIN = "https://paseo-excalidraw.invalid/";
(window as any).EXCALIDRAW_ASSET_PATH = FAKE_ASSET_ORIGIN;

const EMPTY_FONT = "data:font/woff2;base64,";

function dataUrlFor(url: string): string {
  // Any other remote source (Excalidraw's CDN fallback) is dropped: there is no network here.
  if (!url.startsWith(FAKE_ASSET_ORIGIN)) return EMPTY_FONT;
  const key = decodeURIComponent(url.slice(FAKE_ASSET_ORIGIN.length));
  const base64 = Object.prototype.hasOwnProperty.call(FONTS, key) ? FONTS[key] : undefined;
  return base64 ? `data:font/woff2;base64,${base64}` : EMPTY_FONT;
}

const OriginalFontFace = window.FontFace;
const remoteUrl = /url\((["']?)(https?:\/\/[^)"']+)\1\)/g;
(window as any).FontFace = class extends OriginalFontFace {
  constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
    super(
      family,
      typeof source === "string" ? source.replace(remoteUrl, (_m, _q, url) => `url(${dataUrlFor(url)})`) : source,
      descriptors,
    );
  }
};

function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

const realFetch = window.fetch.bind(window);
window.fetch = (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(FAKE_ASSET_ORIGIN)) {
    const key = decodeURIComponent(url.slice(FAKE_ASSET_ORIGIN.length));
    const base64 = Object.prototype.hasOwnProperty.call(FONTS, key) ? FONTS[key] : undefined;
    return Promise.resolve(
      base64
        ? new Response(base64ToBytes(base64), { status: 200, headers: { "Content-Type": "font/woff2" } })
        : new Response(null, { status: 404, statusText: "Not bundled" }),
    );
  }
  // Excalidraw falls back to a CDN (esm.sh) for missing fonts; there is no network here.
  if (/^https?:/i.test(url)) return Promise.reject(new TypeError("Network access is disabled in the diagram frame"));
  return realFetch(input, init);
};
