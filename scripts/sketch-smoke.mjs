// Run in a disposable VM: real browser, saved freehand PNG, and local MCP round trip.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "excalidraw-sketch-"));
const previousHome = process.env.PASEO_HOME;
const scale = process.argv.includes("--scale=2") ? 2 : 1;
let browser;
let endpoint;
try {
  process.env.PASEO_HOME = path.join(temporary, "home");
  const bundle = path.join(temporary, "server.cjs");
  await build({
    stdin: { contents: 'export { startMcpServer } from "./server/mcp"; export { emptyPng, decodePngScene } from "./server/embedded"; export { runtimeHtml } from "./server/runtime.gen";', resolveDir: root },
    bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent",
  });
  const { startMcpServer, emptyPng, decodePngScene, runtimeHtml } = createRequire(import.meta.url)(bundle);
  const empty = emptyPng(JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} })).toString("base64");
  browser = await chromium.launch({ headless: true });
  const errors = [];
  async function openBoard(payload, format = "png") {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: scale });
    page.on("pageerror", error => errors.push(String(error)));
    await page.setContent(`<html><body style="margin:0"><iframe sandbox="allow-scripts allow-downloads" style="width:1100px;height:900px;border:0"></iframe><script>
    window.events=[]; window.addEventListener('message', e=>{window.events.push(e.data); if(e.data.type==='ready') document.querySelector('iframe').contentWindow.postMessage({type:'load',scene:${JSON.stringify(payload)},format:${JSON.stringify(format)},theme:'light'},'*'); });
    document.querySelector('iframe').srcdoc=${JSON.stringify(runtimeHtml).replaceAll("</script", "<\\/script")};
  </script></body></html>`);
    await page.frameLocator("iframe").locator("canvas").first().waitFor({ state: "visible", timeout: 30000 });
    return page;
  }
  const page = await openBoard(empty);
  await page.mouse.click(750, 650);
  await page.keyboard.press("p");
  // A lightbulb and handwritten HI, using freehand strokes only (no text or prebuilt shapes).
  const strokes = [
    [[450,500],[449,476],[432,456],[416,429],[411,400],[417,373],[433,350],[457,337],[484,333],[511,338],[534,352],[549,373],[555,400],[550,427],[535,452],[516,475],[515,500],[450,500]],
    [[449,513],[517,513]], [[454,527],[512,527]], [[464,540],[504,540]],
    [[480,305],[480,280]], [[405,328],[386,306]], [[369,395],[340,395]],
    [[559,329],[582,306]], [[591,395],[619,395]],
    [[660,350],[660,440]], [[710,350],[710,440]], [[660,395],[710,395]],
    [[740,350],[740,440]], [[725,350],[755,350]], [[725,440],[755,440]],
  ];
  for (const points of strokes) {
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(...point, { steps: 3 });
    await page.mouse.up();
  }
  let bytes;
  let scene;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const messages = await page.evaluate(() => window.events);
    assert.deepEqual(messages.filter(message => message.type === "error"), []);
    const saved = messages.filter(message => message.type === "changed").at(-1)?.scene;
    if (saved) {
      bytes = Buffer.from(saved, "base64");
      scene = JSON.parse(decodePngScene(bytes));
      if (scene.elements.length === strokes.length) break;
    }
    await page.waitForTimeout(100);
  }
  assert.equal(scene?.elements.length, strokes.length, "all strokes saved");
  assert.ok(scene.elements.every(element => element.type === "freedraw"));
  // Regression: auto-fitting an initially empty board during the first stroke zoomed to 30x,
  // collapsing the whole sketch into a dot. Count-only assertions did not catch that.
  assert.ok(scene.elements[0].width > 100, "first freehand stroke must not collapse during auto-fit");
  assert.ok(bytes.readUInt32BE(16) > 250 && bytes.readUInt32BE(20) > 250, "export retains sketch geometry");
  const zoom = page.frameLocator("iframe").getByText("100%", { exact: true });
  assert.ok(await zoom.isVisible(), "drawing on an initially blank board keeps normal zoom");
  // Existing large content must still auto-fit when first opened.
  const enlarged = structuredClone(scene);
  for (const element of enlarged.elements) {
    for (const key of ["x", "y", "width", "height"]) element[key] *= 10;
    element.points = element.points.map(point => point.map(value => value * 10));
  }
  const reopened = await openBoard(emptyPng(JSON.stringify(enlarged)).toString("base64"));
  const reopenedFrame = reopened.frames().find(frame => frame.parentFrame());
  await reopenedFrame.waitForFunction(() => [...document.querySelectorAll("button")].some(button => {
    const label = button.textContent.trim();
    return /^\d+%$/.test(label) && parseInt(label, 10) < 100;
  }), null, { timeout: 10000 });
  const remoteBoard = await openBoard(JSON.stringify({ ...scene, elements: [] }), "json");
  await remoteBoard.evaluate(payload => document.querySelector("iframe").contentWindow.postMessage({
    type: "remote", scene: payload, format: "json",
  }, "*"), JSON.stringify(enlarged));
  const remoteFrame = remoteBoard.frames().find(frame => frame.parentFrame());
  await remoteFrame.waitForFunction(() => [...document.querySelectorAll("button")].some(button => {
    const label = button.textContent.trim();
    return /^\d+%$/.test(label) && parseInt(label, 10) < 100;
  }), null, { timeout: 10000 });
  assert.deepEqual(errors, []);
  const file = path.join(temporary, "hand-sketch.excalidraw.png");
  writeFileSync(file, bytes);
  endpoint = await startMcpServer();
  const response = await fetch(endpoint.urlFor(temporary), {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "view_diagram", arguments: { path: "hand-sketch.excalidraw.png" } } }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(body.result.content[1], { type: "image", mimeType: "image/png", data: bytes.toString("base64") });
  assert.deepEqual(readFileSync(file), bytes, "viewing must not modify the board");
  if (process.env.SKETCH_EVIDENCE_DIR) {
    mkdirSync(process.env.SKETCH_EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(process.env.SKETCH_EVIDENCE_DIR, "hand-sketch.excalidraw.png"), bytes);
    await page.screenshot({ path: path.join(process.env.SKETCH_EVIDENCE_DIR, "editor.png") });
  }
  console.log(`PASS ${process.platform}/${process.arch} ${scale}x: ${strokes.length} freehand strokes -> saved ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)} PNG (${bytes.length} bytes) -> native MCP image`);
} finally {
  try {
    await endpoint?.close();
    await browser?.close();
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(temporary, { recursive: true, force: true });
  }
}
