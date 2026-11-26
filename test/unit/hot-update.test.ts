import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createControllableHowl, ControllableHowl } from './mocks';

const createdHowls: ControllableHowl[] = [];

vi.mock('howler', async () => {
  const { createControllableHowl } = await import('./mocks');
  return {
    Howl: vi.fn().mockImplementation(function () {
      const howl = createControllableHowl();
      createdHowls.push(howl);
      return howl;
    }),
    Howler: { ctx: { state: 'running' }, noAudio: false },
  };
});

import {
  abandonStaleSound,
  claimSound,
  freeSound,
  isSoundPlayerStale,
  playSound,
  registerSounds,
  resolveSoundUrl,
  sweepRetiredSounds,
  __resetForTesting,
} from '../../src/runtime';
import { Howl } from 'howler';
import { SoundPack } from '../../src/packs';

const blob = () => new Blob(['audio'], { type: 'audio/mpeg' });
const ok = () => ({ ok: true, status: 200, blob: () => Promise.resolve(blob()), headers: new Headers() });

/** A sound pack registering a single sound at `src` */
const packWith = (src: string, name = 'hot'): SoundPack => ({
  name,
  baseUrl: 'https://cdn.example.com',
  sounds: { hit: { src } },
});

let fetchMock: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let objectUrlCount: number;

beforeEach(() => {
  createdHowls.length = 0;
  vi.clearAllMocks();
  __resetForTesting();

  fetchMock = vi.fn().mockResolvedValue(ok());
  vi.stubGlobal('fetch', fetchMock);

  objectUrlCount = 0;
  createObjectURL = vi.fn(() => `blob:hot-${++objectUrlCount}`);
  revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
});

/** How many times a URL was requested (local HEAD probes use a different path) */
const fetchCountFor = (url: string) => fetchMock.mock.calls.filter(([input]) => input === url).length;

describe('sound pack hot updates', () => {
  it('keeps reusing the cached players when the URL did not change', async () => {
    registerSounds(packWith('v1.mp3'));
    const once = await claimSound('hot/hit');
    const loop = await claimSound('hot/hit', { loop: true });

    registerSounds(packWith('v1.mp3'));

    expect(isSoundPlayerStale(once)).toBe(false);
    expect(isSoundPlayerStale(loop)).toBe(false);
    expect(await claimSound('hot/hit')).toBe(once);
    expect(await claimSound('hot/hit', { loop: true })).toBe(loop);
    expect(Howl).toHaveBeenCalledTimes(2);
    expect(fetchCountFor('https://cdn.example.com/v1.mp3')).toBe(1);
  });

  it('invalidates a subscribed player on URL change and serves the new file next time', async () => {
    registerSounds(packWith('v1.mp3'));
    const old = await claimSound('hot/hit'); // a mounted useSound holds this claim
    old.play();

    registerSounds(packWith('v2.mp3'));

    // Still in use: marked stale but not torn down mid-play
    expect(isSoundPlayerStale(old)).toBe(true);
    expect(old.unload).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    // New plays get a brand new player loaded from the new URL
    const fresh = await claimSound('hot/hit');
    expect(fresh).not.toBe(old);
    expect(fresh.play).not.toHaveBeenCalled();
    expect(fetchCountFor('https://cdn.example.com/v2.mp3')).toBe(1);
    expect(resolveSoundUrl('hot/hit')).toBe('https://cdn.example.com/v2.mp3');

    // Releasing the pre-update claim lets the obsolete player go once its playback ends
    abandonStaleSound('hot/hit');
    expect(old.unload).not.toHaveBeenCalled(); // still playing
    old.finish();
    await vi.waitFor(() => expect(old.unload).toHaveBeenCalled());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:hot-1');
    expect(fresh.unload).not.toHaveBeenCalled();
  });

  it('invalidates the loop player independently of the normal player', async () => {
    registerSounds(packWith('v1.mp3'));
    const once = await claimSound('hot/hit');
    const loop = await claimSound('hot/hit', { loop: true });

    registerSounds(packWith('v2.mp3'));

    expect(isSoundPlayerStale(once)).toBe(true);
    expect(isSoundPlayerStale(loop)).toBe(true);
    expect(once.unload).not.toHaveBeenCalled();
    expect(loop.unload).not.toHaveBeenCalled();

    const newOnce = await claimSound('hot/hit');
    const newLoop = await claimSound('hot/hit', { loop: true });
    expect(newOnce).not.toBe(once);
    expect(newLoop).not.toBe(loop);
    // Normal plays stream through <audio>; loops decode through Web Audio
    expect(vi.mocked(Howl).mock.calls.map(([options]) => options.html5)).toEqual([true, false, true, false]);

    // Each obsolete player is reclaimed by releasing its own claim
    abandonStaleSound('hot/hit', { loop: true });
    expect(loop.unload).toHaveBeenCalled();
    expect(once.unload).not.toHaveBeenCalled();
    abandonStaleSound('hot/hit');
    expect(once.unload).toHaveBeenCalled();
  });

  it('reclaims a stale player when its last playback ends, even unsubscribed', async () => {
    registerSounds(packWith('v1.mp3'));
    const loop = await claimSound('hot/hit', { loop: true });
    loop.play();
    freeSound('hot/hit', { loop: true });
    expect(loop.unload).not.toHaveBeenCalled();

    registerSounds(packWith('v2.mp3'));
    expect(loop.unload).not.toHaveBeenCalled(); // still playing

    loop.finish();
    // The retired player reclaims itself once its playback ends
    await vi.waitFor(() => expect(loop.unload).toHaveBeenCalled());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:hot-1');
  });

  it('invalidates every player of a sound at once when the URL changed', async () => {
    registerSounds(packWith('v1.mp3'));
    const once = await claimSound('hot/hit');
    const loop = await claimSound('hot/hit', { loop: true });
    freeSound('hot/hit');
    freeSound('hot/hit', { loop: true });

    // Both were disposed right away: no stale player lingers in the cache
    await claimSound('hot/hit');
    await claimSound('hot/hit', { loop: true });
    expect(fetchCountFor('https://cdn.example.com/v1.mp3')).toBe(1);

    registerSounds(packWith('v2.mp3'));
    const newOnce = await claimSound('hot/hit');
    const newLoop = await claimSound('hot/hit', { loop: true });

    expect(newOnce).not.toBe(once);
    expect(newLoop).not.toBe(loop);
    expect(fetchCountFor('https://cdn.example.com/v2.mp3')).toBe(1);
  });

  it('does not re-download sounds whose URL did not change', async () => {
    const pack: SoundPack = {
      name: 'multi',
      baseUrl: 'https://cdn.example.com',
      sounds: { a: { src: 'a1.mp3' }, b: { src: 'b1.mp3' } },
    };
    registerSounds(pack);
    const a = await claimSound('multi/a');
    const b = await claimSound('multi/b');

    // Re-register with only `a` changed; `b` keeps its URL, so its player must survive untouched
    registerSounds({ ...pack, sounds: { a: { src: 'a2.mp3' }, b: { src: 'b1.mp3' } } });

    expect(isSoundPlayerStale(a)).toBe(true);
    expect(isSoundPlayerStale(b)).toBe(false);
    expect(await claimSound('multi/b')).toBe(b);
    expect(fetchCountFor('https://cdn.example.com/b1.mp3')).toBe(1);
    expect(fetchCountFor('https://cdn.example.com/a1.mp3')).toBe(1);
  });

  it('never installs a player built from a blob fetched before the URL change', async () => {
    registerSounds(packWith('v1.mp3'));

    // Gate the blob GET (the local HEAD probe comes first and resolves normally)
    let releaseFetch: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => (releaseFetch = resolve));
    let getCalls = 0;
    fetchMock.mockImplementation(() => {
      getCalls += 1;
      return getCalls === 1 ? Promise.resolve(ok()) : gate; // 1st = local HEAD
    });

    const pending = claimSound('hot/hit');
    // Wait until the claim is actually awaiting the gated v1 blob download
    await vi.waitFor(() => expect(getCalls).toBe(2));

    registerSounds(packWith('v2.mp3'));
    releaseFetch(ok());

    const howl = await pending;
    expect(isSoundPlayerStale(howl)).toBe(false);
    // The v1 download was discarded; a second request fetched the new file
    expect(fetchCountFor('https://cdn.example.com/v1.mp3')).toBe(1);
    expect(fetchCountFor('https://cdn.example.com/v2.mp3')).toBe(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('survives a failed download of the obsolete URL while loading the new one', async () => {
    registerSounds(packWith('v1.mp3'));

    let failFetch: (reason: Error) => void = () => {};
    const gate = new Promise((_resolve, reject) => (failFetch = reject));
    let v1Requests = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url === 'https://cdn.example.com/v1.mp3') {
        v1Requests += 1;
        return gate;
      }
      return Promise.resolve(ok());
    });

    const pending = claimSound('hot/hit');
    // Wait until the claim is actually awaiting the gated v1 download
    await vi.waitFor(() => expect(v1Requests).toBe(1));

    registerSounds(packWith('v2.mp3'));
    failFetch(new Error('404 on the old file'));

    const howl = await pending;
    expect(isSoundPlayerStale(howl)).toBe(false);
    expect(fetchCountFor('https://cdn.example.com/v2.mp3')).toBe(1);
  });

  it('shares one download between concurrent plays after an update', async () => {
    registerSounds(packWith('v1.mp3'));
    const previous = await claimSound('hot/hit');
    freeSound('hot/hit');
    expect(previous.unload).toHaveBeenCalled();

    registerSounds(packWith('v2.mp3'));

    const [a, b] = await Promise.all([claimSound('hot/hit'), claimSound('hot/hit')]);
    expect(a).toBe(b);
    expect(fetchCountFor('https://cdn.example.com/v2.mp3')).toBe(1);
    expect(Howl).toHaveBeenCalledTimes(2); // one before the update, one after
  });

  it('playSound ends on a stale player that finishes naturally, then reclaims it', async () => {
    registerSounds(packWith('v1.mp3'));
    const playing = playSound('hot/hit');
    // Let the claim reach the player and call play()
    await vi.waitFor(async () => {
      expect(createdHowls.length).toBe(1);
    });
    await playing;

    const old = createdHowls[0];
    expect(old.play).toHaveBeenCalled();

    registerSounds(packWith('v2.mp3'));
    expect(old.unload).not.toHaveBeenCalled();

    // The old playback ends on its own: playSound's end handler releases the claim
    old.finish();
    await vi.waitFor(() => {
      expect(old.unload).toHaveBeenCalled();
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:hot-1');
  });

  it('never returns a stale player to a new play, even while it is still playing', async () => {
    registerSounds(packWith('v1.mp3'));
    const old = await claimSound('hot/hit');
    old.play();

    registerSounds(packWith('v2.mp3'));

    // The stale player is still running for its old subscribers...
    expect(isSoundPlayerStale(old)).toBe(true);
    // ...but a new play gets the freshly loaded file
    const fresh = await claimSound('hot/hit');
    expect(fresh).not.toBe(old);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('routes releases to the right player when a stale and a fresh claim overlap', async () => {
    registerSounds(packWith('v1.mp3'));
    const old = await claimSound('hot/hit');
    old.play(); // old play still running

    registerSounds(packWith('v2.mp3'));
    const fresh = await claimSound('hot/hit'); // new play, held by the same cache key

    // A release arriving for a *current* player must not tear down the still-running stale one
    freeSound('hot/hit');
    expect(fresh.unload).toHaveBeenCalled();
    expect(old.unload).not.toHaveBeenCalled();

    // The stale play is done with its claim and lets the old player end naturally
    abandonStaleSound('hot/hit');
    expect(old.unload).not.toHaveBeenCalled(); // still playing
    old.finish();
    await vi.waitFor(() => expect(old.unload).toHaveBeenCalled());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:hot-1');
  });

  it('releases a stopped, unsubscribed stale player on demand via sweepRetiredSounds', async () => {
    registerSounds(packWith('v1.mp3'));
    const old = await claimSound('hot/hit');
    old.play();

    registerSounds(packWith('v2.mp3'));
    // A hook stops the stale playback and releases its claim, without any "end" event
    abandonStaleSound('hot/hit');
    expect(old.unload).not.toHaveBeenCalled(); // was still playing when freed

    old.stop();
    expect(old.unload).not.toHaveBeenCalled(); // nothing triggers a cleanup until asked
    sweepRetiredSounds('hot/hit');

    expect(old.unload).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:hot-1');
  });
});
