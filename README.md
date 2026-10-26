# paseo-excalidraw

View and edit [Excalidraw](https://excalidraw.com) diagrams inside [Paseo](https://paseo.sh), together with your coding agents.

- A workspace panel lists the `.excalidraw` files in the workspace, opens them in the real Excalidraw editor and creates new ones.
- You and agents can edit the same file at once. Changes show up within about a second and are merged with Excalidraw's own element reconciliation.
- Supported new agents get diagram tools over a local MCP server: `list_diagrams`, `read_diagram`, `view_diagram`, `create_diagram`, `add_shape`, `add_text`, `connect`, `update`, `delete`, `align` and `build_diagram`.

Works with Paseo 0.11.2 or later. The editor runs in the desktop and web apps; on mobile the panel shows a notice.

## Install

> **Trust warning.** Paseo plugins are unsandboxed. Installing this one means you trust this repository: its server code runs with your user's access on the machine that runs the Paseo daemon, its client code runs inside the Paseo app, and its build step (`npm ci`, `npm run build`) runs on the daemon host. Future updates and the dependency tree are part of that decision. Read the source first.

Plugins must be enabled on the daemon (Settings → Plugins → Enable plugins, or `pluginsEnabled: true` in `config.json` followed by `paseo reload`).

```bash
paseo plugin add github:lerenn/paseo-excalidraw
paseo plugin ls
```

Paseo 0.11 resolves a bare `owner/repo` through the plugin registry, so GitHub installs use the `github:` prefix. Use `--ref <branch|tag|commit>` to pick a revision and `paseo plugin update excalidraw` to update. With `--host`, the install, including `npm ci`, runs on that remote daemon.

Then open a workspace, add a tab, and choose **Excalidraw** (or run "Open Excalidraw diagrams" from the Command Center). The panel declares an Explorer sidebar location as well (not yet tested).

New Claude, Codex, OpenCode and Copilot agents get the tools automatically. Pi injection is **off by default**: open the host’s **Plugins** settings, then Excalidraw’s actions menu → **Agent tools** and enable **Enable Pi diagram tools** only after verifying MCP support on that host. An incompatible Pi runtime or a failed MCP probe can prevent new Pi agents from starting while this option is enabled; turn it off to restore the safe default. Other providers are untouched. Existing agents keep their saved configuration and do not receive the tools retroactively.

The documented image-forwarding workflow targets Pi 1.3.0 with built-in MCP. Older Pi versions and `pi-mcp-adapter` are not covered by that snippet; adapter exposure and image handling differ. A universal minimum Pi version is not established. The plugin SDK/settings APIs were checked against Paseo 0.11.2, but Pi integration must also be verified with the installed daemon and runtime. See the local verification limits below.

## Using it

- **Files:** the panel lists `.excalidraw`, `.excalidraw.svg` and `.excalidraw.png` files anywhere in the workspace (not in `node_modules`, `.git`, `dist`, `build`). Type a name such as `docs/architecture` (or `docs/architecture.excalidraw.svg`) and press **New diagram**. The last diagram you opened in a workspace is reopened next time.
- **Agents:** ask an agent to "draw the request flow in `docs/flow.excalidraw`". Typical tool use is `read_diagram` to get element ids, then `build_diagram` for a whole flowchart, or `add_shape`, `connect`, `update`, `align` for incremental changes.

## Reading hand sketches

Create a whiteboard named, for example, `docs/sketch.excalidraw.png` in the panel, draw with the
freehand tool, and let it save (PNG saves are debounced by about 1.2 seconds). Ask a **vision-capable**
agent to "use view_diagram to explain my sketch in docs/sketch.excalidraw.png". The tool returns the
actual saved PNG as an MCP image, not a textual guess based on stroke coordinates. Handwriting
interpretation depends on the selected model, is not guaranteed, and is not a substitute for OCR accuracy testing; ask the agent to confirm uncertain details.

`read_diagram` still returns a compact structural summary for all formats. `view_diagram` works
only on `.excalidraw.png`: JSON and SVG are not rendered by the daemon. PNG whiteboards remain
editable in the panel, but agents cannot modify image formats. Use plain `.excalidraw` when you
need agent edits; this release does not provide visual rendering of that format. Images over
4 MiB are refused before loading the image contents. Images over 4096 exported pixels in either dimension are also refused; these are image pixels, not screen/CSS pixels, so high density exports can reach the limit sooner. Split large sketches into smaller boards.

Pi 1.3.0 with built-in MCP defaults to codemode exposure. This example does not apply to `pi-mcp-adapter`. To make an image visible to the model, forward the returned
image block, rather than printing its base64 data:

```js
const result = await tools.mcp__excalidraw__view_diagram({
  path: "docs/sketch.excalidraw.png",
});
for (const block of result.content ?? []) {
  if (block.type === "image") image(block);
  else if (block.type === "text") text(block.text);
}
```

No OCR service, daemon-side browser renderer, or extra model is installed. Images stay on the daemon until
an agent reads them; the agent's configured model provider then receives the image, just as it
receives diagram text. The original PNG, including its embedded editable scene and pasted-image data, is sent unchanged; the limit includes that metadata. The embedded scene is retained as part of the original export; stripping only scene text chunks is a possible future payload optimization, not required for visual reading. A text-only model cannot interpret the image. Image delivery to a model has not been verified for Claude, Codex, OpenCode or Copilot; a vision-capable model alone is not proof that its agent forwards MCP images.

## File formats

| Format | Panel | Agents |
| --- | --- | --- |
| `.excalidraw` (JSON) | create, open, edit | list, read, edit |
| `.excalidraw.svg` | create, open, edit (saved as an SVG with the scene embedded) | list, read |
| `.excalidraw.png` | create, open, edit (saved as a PNG with the scene embedded) | list, read, view image |

Image diagrams are exported by Excalidraw itself inside the iframe (`exportToSvg` / `exportToBlob` with "embed scene"; `loadFromBlob` reads them back). The daemon cannot render pictures, so it only decodes the embedded scene for agents and refuses server-side edits to images instead of leaving a stale picture. Images embed live elements only, so unlike the JSON format they carry no tombstones: a deletion made during a concurrent edit of the same image can be resurrected by the merge. Saving an image re-exports it, so it is debounced longer (about 1.2 s) than JSON (0.35 s).

## How it works

| Piece | Where | Notes |
| --- | --- | --- |
| Panel | `client/` | React Native components only. Native renders a notice and never touches Excalidraw. |
| Excalidraw runtime | `runtime-src/` → `server/runtime.gen.ts` | Prebuilt by `npm run build` into one HTML document (React, Excalidraw, CSS and fonts inlined, English only). The daemon serves it gzipped in chunks over plugin RPC. The client caches it by content hash for the page's lifetime and mounts it in a sandboxed iframe through `client/web.ts`. The iframe has a CSP with no network access. |
| File access | `server/files.ts`, `server/paths.ts` | All reads and writes happen in the daemon process, which is the single writer (per-file lock, atomic rename). Paths must be `.excalidraw`, `.excalidraw.svg` or `.excalidraw.png` files inside the workspace; `..`, absolute paths and symlinks that leave it are rejected. |
| Versions and merge | `server/files.ts`, `client/diagram-view.tsx`, `runtime-src/main.tsx` | A file's version is a hash of its bytes. Writes carry the version the client last saw; a stale write is rejected and answered with the current file, which the iframe merges with `reconcileElements`. Live sync is a ~1 s `stat` poll; the plugin has no server-to-client push channel. |
| Agent tools | `server/mcp.ts`, `server/tools.ts`, `server/scene.ts` | A small MCP server over streamable HTTP on `127.0.0.1`. `server.before("agent.create")` adds it to supported new agents' `mcpServers`; Pi requires explicit opt-in. Each agent gets its own URL, signed with a secret and bound to its working directory. Excalidraw cannot run in Node, so `server/scene.ts` builds the elements (shapes, bound labels, arrows with matching `startBinding`/`endBinding` and `boundElements`); Excalidraw re-measures text when it loads the file. |

The MCP port and secret persist in `$PASEO_HOME/plugin-data/excalidraw/mcp.json` (mode 0600). Agents save their MCP URL in their configuration, and `agent.create` hooks do not run again on resume or refresh, so the plugin reclaims the same port and secret after a reload or daemon restart. If that port is taken by another process, a new port is chosen and existing agents must be recreated to get working tools.

## Development

```bash
npm install
npm run typecheck     # also builds the iframe runtime if it is missing
npm run build         # rebuild server/runtime.gen.ts after changing runtime-src/
npm test              # real files/HTTP plus isolated hook-policy tests
npx playwright install chromium --with-deps  # browser-test VM setup only
npm run test:browser   # freehand + remote population + PNG -> MCP, 1x/2x; disposable VM only

paseo plugin install "$PWD"      # directory install; run `npm run build` first
paseo plugin reload excalidraw   # after edits
paseo plugin logs excalidraw
```

`server/runtime.gen.ts` and `runtime-src/fonts.gen.ts` are generated and not committed. Git installs generate them through the `build` commands in `paseo-plugin.json`; directory installs do not run `build`, so run `npm run build` yourself.

Do not enable plugins on, or restart, a daemon you did not intend to change. Test against an isolated daemon with its own `PASEO_HOME` and port.

## Verification boundaries

The Pi SDK/codemode image check uses a synthetic assistant tool call and no model requests. It is not an end-to-end test of Paseo plugin installation, agent creation, or model interpretation. Test those paths on the exact daemon/runtime before enabling Pi injection. The browser smoke checks freehand geometry, handwritten strokes as image pixels, remote population of an empty board, and image transport at 1x/2x display scale; it does not measure handwriting recognition accuracy. Dagger is configured to run this smoke and reuse its browser setup layer when its engine cache persists; fresh CI runners still download dependencies; successful local commands are not evidence of a completed CI run.

## License

MIT, see [LICENSE](LICENSE). Excalidraw is also MIT licensed and is bundled into the diagram runtime.
