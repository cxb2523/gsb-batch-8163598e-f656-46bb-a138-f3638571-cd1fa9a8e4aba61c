/**
 * The engine's lifecycle, on a real AudioContext in headless Chrome: what a
 * skip does with the old song — its bus faded out, then disconnected whole,
 * its cues gone from the timeline — that a song ending by itself gives its bus
 * back too, that pause stops the audio clock where it is and resume carries on
 * from there, and that a skip and a pause crossing paths leave the last one
 * asked for in charge.
 *
 * The modules are bundled straight from src/ (no build needed) and run in a
 * blank page. Needs a local Chrome (or CHROME=/path/to/chrome).
 */
import { build } from 'esbuild';
import { sleep, launch } from '../tools/chrome.mjs';
import { checker, load, root } from '../tools/load.mjs';

const { check, done } = checker();
const { makeSong } = await load('core/music');

const bundle = await build({
  stdin: {
    contents: `
      import { Engine } from './src/app/audio';
      import { makeSong, barSeconds } from './src/core/music';
      export const harness = { Engine, makeSong, barSeconds };
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: 'EngineTest',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
});

const browser = await launch({ width: 400, height: 300, flags: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
if (!browser) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the engine test.');
  process.exit(0);
}

const { evaluate } = browser;
const run = (body) => evaluate(`(async () => { ${body} })()`);

try {
  await evaluate(bundle.outputFiles[0].text);

  // The engine on the page, muted: the test listens to its bookkeeping, not its sound.
  await run(`
    const { Engine } = EngineTest.harness;
    window.engine = new Engine();
    window.engine.setVolume(0);
    await window.engine.resume();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return true;
  `);

  // ---- Skips: the old bus goes, and takes all of its nodes with it ----
  const afterSkips = await run(`
    const { Engine, makeSong } = EngineTest.harness;
    const engine = window.engine;
    for (let i = 0; i < 6; i++) {
      engine.play(makeSong('skip-' + i, null));
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    engine.tick();
    const during = engine.stats();
    // The last skips' buses are fading: they still exist, but no more than the fade window's worth.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    engine.tick();
    return { during, after: engine.stats() };
  `);
  check('a bus per song, one live after many skips', afterSkips.after.live, 1);
  check('no bus is left fading', afterSkips.after.retiring, 0);
  check('every bus made was released', afterSkips.after.created - afterSkips.after.released, 1);
  // Each skip retires one bus for about a second: a handful, never one per skip.
  check('fading buses do not pile up', afterSkips.during.live <= 4, true);

  // ---- Cues: a skip starts a timeline of its own ----
  const cues = await run(`
    const { makeSong } = EngineTest.harness;
    const engine = window.engine;
    // Bars of the old song are scheduled ahead of the audio clock, waiting.
    engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const oldCount = engine.stats().cues;
    // The skip: the new song begins just after now, and none of the old song's
    // waiting cues may be taken for its own.
    engine.play(makeSong('fresh', null));
    const start = engine.now();
    const fresh = engine.takeCues(Number.MAX_SAFE_INTEGER);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const later = engine.takeCues(Number.MAX_SAFE_INTEGER);
    const all = fresh.concat(later);
    return {
      oldCount,
      count: all.length,
      afterStart: all.every((cue) => cue.time >= start - 0.05),
    };
  `);
  check('the old song had cues waiting', cues.oldCount > 0, true);
  check('the new song has cues', cues.count > 0, true);
  check('no cue is from the old timeline', cues.afterStart, true);

  // ---- Pause: the clock stands still, and resumes where it stopped ----
  const paused = await run(`
    const engine = window.engine;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = engine.now();
    const cuesBefore = engine.stats().cues;
    await engine.pause();
    await new Promise((resolve) => setTimeout(resolve, 900));
    engine.tick();
    const during = engine.now();
    const cuesDuring = engine.stats().cues;
    await engine.resume();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = engine.now();
    return { before, during, cuesBefore, cuesDuring, after };
  `);
  check('paused: the audio clock does not advance', Math.abs(paused.during - paused.before) < 0.15, true);
  check('paused: no bar is scheduled ahead', paused.cuesDuring <= paused.cuesBefore, true);
  check('resumed: the clock carries on from where it stopped', paused.after > paused.during + 0.2, true);
  check('resumed: without jumping ahead of real time', paused.after - paused.during < 2, true);

  // ---- Skip and pause crossing: the last one asked for wins ----
  const crossing = await run(`
    const { makeSong } = EngineTest.harness;
    const engine = window.engine;
    await engine.pause();
    // A skip while paused starts the new song at once: its bus is the live one.
    engine.play(makeSong('crossing', null));
    await engine.resume();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    engine.tick();
    const afterSkipAfterPause = { state: engine.ctx.state, ...engine.stats() };

    // A resume and a pause asked for back to back: the pause, asked last, holds.
    const a = engine.resume();
    const b = engine.pause();
    await Promise.all([a, b]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pausedAfterBoth = engine.ctx.state;
    const clockA = engine.now();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const clockB = engine.now();
    await engine.resume();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      afterSkipAfterPause,
      pausedAfterBoth,
      frozen: Math.abs(clockB - clockA) < 0.1,
      playingAgain: engine.ctx.state === 'running',
    };
  `);
  check('skip after pause: playing', crossing.afterSkipAfterPause.state, 'running');
  check('skip after pause: one live bus, the new one', crossing.afterSkipAfterPause.live, 1);
  check('the old bus was released without touching the new', crossing.afterSkipAfterPause.released >= 2, true);
  check('resume then pause: the pause holds', crossing.pausedAfterBoth, 'suspended');
  check('resume then pause: the clock is frozen', crossing.frozen, true);
  check('a later resume plays again', crossing.playingAgain, true);

  // ---- A song ending by itself gives its bus back ----
  const ended = await run(`
    const { makeSong } = EngineTest.harness;
    const engine = window.engine;
    engine.tick();
    const before = engine.stats();
    const song = makeSong('short', null);
    song.sections = [song.sections[0]];
    song.sections[0].bars = 1;
    let endedAt = null;
    engine.onSongEnd = (time) => { endedAt = time; };
    engine.play(song);
    const afterPlay = engine.stats();
    engine.scheduleUntil(engine.now() + 60);
    const afterEnd = { endedAt, ...engine.stats() };
    // The last bar rings out, then the bus is unmade: 3 s fade, 6 s tail, half a second.
    await new Promise((resolve) => setTimeout(resolve, 12000));
    engine.tick();
    const after = engine.stats();
    engine.onSongEnd = () => undefined;
    return { before, afterPlay, afterEnd, after };
  `);
  check('the short song gets a bus of its own', ended.afterPlay.live - ended.before.live, 1);
  check('the song that ends says so', typeof ended.afterEnd.endedAt === 'number', true);
  check('its bus rings out before it is unmade', ended.afterEnd.retiring - ended.afterPlay.retiring, 1);
  check('the ended bus is released', ended.after.released - ended.afterEnd.released >= 1, true);
  check('nothing is left fading', ended.after.retiring, 0);
  check('no bus of the ended song is left live', ended.after.live, 0);
  check('every bus the test made was released', ended.after.created, ended.after.released);

  check('no errors in the page', browser.errors, []);
} finally {
  await browser.close();
}

done('engine');
