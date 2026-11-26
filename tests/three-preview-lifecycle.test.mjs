import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

async function loadPreviewModule() {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  return {
    vite,
    mod: await vite.ssrLoadModule(
      '/src/lib/volume/three-preview/index.ts',
    ),
  };
}

test('createThreePreview rejects as aborted when cancellation is already requested', async (t) => {
  const { vite, mod } = await loadPreviewModule();
  t.after(() => vite.close());

  // The host must never be touched on the pre-import fast path.
  const host = {};
  const volume = {};

  await assert.rejects(
    () => mod.createThreePreview(host, volume, { cancelled: true }),
    (error) => error?.name === 'AbortError',
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => mod.createThreePreview(host, volume, controller.signal),
    (error) => error?.name === 'AbortError',
  );
  await assert.rejects(
    () =>
      mod.createThreePreview(host, volume, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  await assert.rejects(
    () => mod.createThreePreview(host, volume, () => true),
    (error) => error?.name === 'AbortError',
  );
});

test('createThreePreview honours cancellation that arrives while modules load', async (t) => {
  const { vite, mod } = await loadPreviewModule();
  t.after(() => vite.close());

  // First probe (before the parallel dynamic imports) says "not cancelled";
  // every later probe (after imports settle) says "cancelled". This proves the
  // post-await guard runs before buildPreview touches the host / WebGL.
  let probes = 0;
  const isCancelled = () => {
    probes += 1;
    return probes > 1;
  };

  const touchedHost = {
    replaceChildren() {
      throw new Error('cancelled creation must not touch the host');
    },
    appendChild() {
      throw new Error('cancelled creation must not append a canvas');
    },
  };

  await assert.rejects(
    () =>
      mod.createThreePreview(touchedHost, {}, { isCancelled }),
    (error) => error?.name === 'AbortError',
  );
  assert.ok(probes >= 2, 'expected a probe before and after imports');
});
