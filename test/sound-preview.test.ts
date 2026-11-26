import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// SoundPreview is a client component: it needs React's DOM renderer and a document. The
// component is bundled once with esbuild (TSX + the app's @/ alias) and imported into a
// jsdom global, so the test exercises the real file rather than a copy of its logic.

let dom: JSDOM;
let outDir: string;
let moduleUrl: string;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: false,
  });
  const put = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  };
  // Node 24 ships a read-only `navigator`; React DOM reads these globals at import time.
  put("window", dom.window);
  put("document", dom.window.document);
  put("navigator", dom.window.navigator);
  put("HTMLElement", dom.window.HTMLElement);
  put("Node", dom.window.Node);
  put("Event", dom.window.Event);
  put("MutationObserver", dom.window.MutationObserver);
  put("IS_REACT_ACT_ENVIRONMENT", true);

  outDir = await mkdtemp(path.join(tmpdir(), "soundpreview-"));
  const entry = path.join(outDir, "entry.tsx");
  const root = process.cwd();
  await writeFile(
    entry,
    `
    import { createRoot } from "react-dom/client";
    import { act, createElement } from "react";
    import { SoundPreview } from ${JSON.stringify(path.join(root, "components/SoundPreview.tsx"))};
    export { createRoot, act, createElement, SoundPreview };
    `,
  );

  const out = path.join(outDir, "bundle.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    outfile: out,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    nodePaths: [path.join(root, "node_modules")],
    alias: { "@": root, sonner: path.join(root, "test/stubs/sonner.ts") },
  });
  moduleUrl = pathToFileURL(out).href;
});

after(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
  dom?.window.close();
});

describe("SoundPreview session wiring", () => {
  it("a second trigger stops the first handle before the second plays", async () => {
    const { createRoot, act, createElement, SoundPreview } = await import(moduleUrl);
    const stops: number[] = [];
    const started: number[] = [];
    let n = 0;

    // Each trigger hands the component a fresh handle, so the session's bookkeeping is
    // the only thing that can stop the previous one.
    const makeHandle = () => {
      const id = ++n;
      started.push(id);
      return {
        duration: 0.2,
        ended: false,
        stop() {
          stops.push(id);
        },
      };
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SoundPreview, { onTrigger: () => makeHandle(), onTriggerReverse: () => makeHandle() }));
    });

    const tap = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Tap me",
    )!;
    await act(async () => {
      tap.click();
    });
    await act(async () => {
      tap.click();
    });

    assert.deepEqual(started, [1, 2]);
    assert.deepEqual(stops, [1], "only the superseded handle was stopped");

    await act(async () => root.unmount());
    assert.deepEqual(stops, [1, 2], "unmount stopped the live handle");
    container.remove();
  });

  it("unmount during an in-flight start stops the late handle", async () => {
    const { createRoot, act, createElement, SoundPreview } = await import(moduleUrl);
    const stops: number[] = [];
    let resolveStart: (h: { duration: number; ended: boolean; stop(): void }) => void = () => {};
    const pending = new Promise<{ duration: number; ended: boolean; stop(): void }>((r) => {
      resolveStart = r;
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(SoundPreview, { onTrigger: () => pending, onTriggerReverse: () => pending }));
    });

    const tap = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Tap me",
    )!;
    await act(async () => {
      tap.click();
    });

    await act(async () => root.unmount());

    const late = {
      duration: 0.2,
      ended: false,
      stop() {
        stops.push(1);
      },
    };
    resolveStart(late);
    await pending;
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(stops, [1], "the handle that arrived after unmount was stopped");
    container.remove();
  });
});
