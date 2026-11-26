import { Howl, Howler } from "howler";
import manifest from "./manifest.json";
import {
  __resetPacksForTesting,
  addPack,
  CustomSoundNames,
  getPackSoundUrl,
  isPackSoundName,
  RegisterSoundsOptions,
  SoundPack,
} from "./packs";
import { AudioPermissionStatus, LibrarySoundName, SoundOptions } from "./types";

/**
 * A built-in sound, a sound from a registered pack, or the URL of an MP3 file.
 * (`string & {}` keeps editor autocompletion for the known names.)
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type SoundName = LibrarySoundName | keyof CustomSoundNames | (string & {});

export function isLibrarySoundName(name: any): name is LibrarySoundName {
  return name in manifest.sounds;
}

// Default CDN base URL
let cdnBaseUrl = "https://reactsounds.sfo3.cdn.digitaloceanspaces.com/v1";

// Global sound enabled state
let soundEnabledGlobal = true;

// Global event listeners for sound state changes
const soundStateListeners: Array<(enabled: boolean) => void> = [];

// Track if we've already set up audio context unlocking
let audioUnlockInitialized = false;

/**
 * Set a custom CDN base URL
 */
export function setCDNUrl(url: string): void {
  cdnBaseUrl = url;
}

/**
 * Get the CDN base URL
 */
export function getCDNUrl(): string {
  return cdnBaseUrl;
}

/**
 * Cache of preloaded sound blobs to avoid HTML5 audio pool exhaustion
 */
const soundBlobCache: Record<string, Promise<Blob>> = {};

// TODO: turn "subscriptions" into a list of ids for better lock tracking
export type HowlEntry = {
  instance: Howl;
  subscriptions: number;
  /** The object URL the player was loaded from, revoked when the player is disposed */
  objectUrl?: string;
  /** Set when a sound pack re-registered with a different URL for this sound */
  stale?: boolean;
  /** Guards against unloading/revoking the same player twice */
  disposed?: boolean;
};

/**
 * Cache of created Howl instances (only created when actually played)
 */
const howlInstanceCache: Record<string, HowlEntry> = {};

/**
 * Players invalidated by a pack re-registration that are still subscribed or playing.
 * They are kept around until they have no subscribers and are no longer playing, then disposed.
 */
const retiredHowlInstances: Record<string, HowlEntry[]> = {};

/**
 * Outstanding claims for each cache key, oldest first. A claim is tied to the exact player it was
 * made on, so a play that started before a hot update is released against the old player even if a
 * newer player now occupies the cache slot.
 */
const pendingClaims: Record<string, HowlEntry[]> = {};

/**
 * Bumped every time a sound's URL changes. Player creation captures the version before loading the
 * blob and starts over when it changed in the meantime, so an in-flight load can never install a
 * player for an outdated URL.
 */
const soundVersions: Record<string, number> = {};

/** Resolve the cache entry behind a Howl, so callers can identify the player they hold */
let entryByHowl = new WeakMap<Howl, HowlEntry>();

/**
 * Which player a sound uses. Sounds play through an <audio> element (Howler's html5 mode), except
 * looped plays: those use Web Audio, which repeats the decoded sound without the short pause an
 * <audio> element makes every time it restarts. A sound that is played both ways gets one of each.
 */
export interface PlayerOptions {
  loop?: boolean;
}

const cacheKey = (name: SoundName, { loop = false }: PlayerOptions = {}) => (loop ? `${name}\u0000loop` : name);

/**
 * Make a sound loader function that first tries local files then falls back to CDN
 */
export function makeRemoteSound(name: SoundName, options?: PlayerOptions): () => Promise<HowlEntry> {
  return async () => createOrGetHowlInstance(name, options);
}

export async function claimSound(name: SoundName, options?: PlayerOptions): Promise<Howl> {
  const key = cacheKey(name, options);
  for (;;) {
    const entry = await makeRemoteSound(name, options)();

    // A pack re-registration may have invalidated this player in the meantime. Never attach a new
    // play to a stale player: start over so this play loads the sound's current URL.
    if (entry.disposed || entry.stale) continue;

    entry.subscriptions += 1;
    (pendingClaims[key] ??= []).push(entry);

    return entry.instance;
  }
}

export function freeSound(name: SoundName, options?: PlayerOptions) {
  const key = cacheKey(name, options);

  // Release a claim on a current player. Claims on players invalidated by a hot update are released
  // through abandonStaleSound instead, so a stale player never steals a fresh player's release.
  if (!releaseClaim(key, (entry) => !entry.stale)) releaseClaim(key, (entry) => entry.stale === true);

  cleanupUnusedSound(key);
  releaseRetiredSounds(key);

  return null;
}

/**
 * Release a claim on a player invalidated by a sound pack hot update, once the caller is done with it
 * (its playback ended, the hook stopped, or it switched to the new player). The retired player is
 * then reclaimed once it is no longer playing.
 * @internal
 */
export function abandonStaleSound(name: SoundName, options?: PlayerOptions): null {
  const key = cacheKey(name, options);

  releaseClaim(key, (entry) => entry.stale === true);
  releaseRetiredSounds(key);

  return null;
}

/**
 * Release the oldest outstanding claim matching `matches`. Claims on players disposed by an earlier
 * hot update are dropped on the way. Returns whether a claim was released.
 */
function releaseClaim(key: string, matches: (entry: HowlEntry) => boolean): boolean {
  const claims = pendingClaims[key];
  if (!claims) return false;

  const index = claims.findIndex((entry) => entry.subscriptions > 0 && !entry.disposed && matches(entry));
  if (index >= 0) claims[index].subscriptions -= 1;

  const live = claims.filter((entry) => entry.subscriptions > 0 && !entry.disposed);
  if (live.length > 0) pendingClaims[key] = live;
  else delete pendingClaims[key];

  return index >= 0;
}

/**
 * Fetches sound data as a blob, from local filesystem or CDN
 */
export async function fetchSoundBlob(name: SoundName): Promise<Blob> {
  try {
    // Try to fetch from local first
    const localPath = await getLocalSoundPath(name);
    if (localPath) {
      const response = await fetch(localPath);
      if (response.ok) return await response.blob();
    }
  } catch (error) {
    console.warn(`Error loading local sound "${name}", falling back to CDN:`, error);
  }

  const packUrl = getPackSoundUrl(name);
  if (packUrl) {
    const response = await fetch(packUrl);
    if (!response.ok) throw new Error(`Failed to fetch sound "${name}" from ${packUrl} (HTTP ${response.status})`);
    return await response.blob();
  }

  if (!isLibrarySoundName(name)) {
    throw new Error(
      `Failed to load custom sound "${name}". ` +
        "If this is a URL on another domain, make sure it serves an MP3 file with CORS headers (Access-Control-Allow-Origin)."
    );
  }

  // Fall back to CDN
  const soundInfo = manifest.sounds[name];
  const soundUrl = `${cdnBaseUrl}/${soundInfo.src}`;

  const response = await fetch(soundUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch sound "${name}" from CDN`);
  }

  return await response.blob();
}

/**
 * Register a sound pack so its sounds can be played by name, e.g. `useSound("my-ui-pack/save")`.
 * Registering the same pack again is a no-op; registering a changed pack updates its sounds.
 */
export function registerSounds(pack: SoundPack, options?: RegisterSoundsOptions): void {
  for (const name of addPack(pack, options)) {
    // Drop stale data for sounds whose URL changed
    delete soundBlobCache[name];
    soundVersions[name] = (soundVersions[name] ?? 0) + 1;

    // Invalidate cached players: the next play must load the new URL instead of reusing the old file
    invalidatePlayers(name);
  }
}

/**
 * Invalidate every cached player (normal and looped) of a sound whose URL changed.
 *
 * Players without subscribers and not playing are disposed right away. Players still in use are
 * retired: they stay alive until their last subscriber frees them and their playback ends, then get
 * disposed. They are removed from the cache immediately so new plays never reach the old file.
 */
function invalidatePlayers(name: SoundName): void {
  for (const loop of [false, true]) {
    const key = cacheKey(name, { loop });
    const entry = howlInstanceCache[key];
    if (!entry) continue;

    delete howlInstanceCache[key];
    entry.stale = true;

    if (entry.subscriptions === 0 && !isPlaying(entry)) {
      disposeEntry(entry);
    } else {
      (retiredHowlInstances[key] ??= []).push(entry);
      // Reclaim the retired player on its own when its last playback finishes, even if nothing
      // calls freeSound for it afterwards
      entry.instance.on("end", () => {
        // Howler marks the finished sound as stopped right after emitting "end", so check next tick
        Promise.resolve().then(() => {
          if (!entry.disposed && entry.subscriptions === 0) releaseRetiredSounds(key);
        });
      });
    }
  }
}

/**
 * Whether a player was invalidated by a sound pack hot update. New plays must not use it.
 * @internal
 */
export function isSoundPlayerStale(howl: Howl): boolean {
  return entryByHowl.get(howl)?.stale === true;
}

/**
 * Dispose every retired player of a sound that is no longer subscribed nor playing. Call after
 * stopping a stale player so its object URL is released without waiting for another play.
 * @internal
 */
export function sweepRetiredSounds(name: SoundName): void {
  releaseRetiredSounds(cacheKey(name));
  releaseRetiredSounds(cacheKey(name, { loop: true }));
}

/** Whether any playback of this player is still running */
function isPlaying(entry: HowlEntry): boolean {
  try {
    return entry.instance.playing();
  } catch {
    return false;
  }
}

/**
 * Unload a player and release the object URL it was loaded from. Safe to call more than once.
 */
function disposeEntry(entry: HowlEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;

  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  entry.instance.unload();
}

/**
 * Dispose retired players of a cache key that no longer have subscribers and are done playing.
 */
function releaseRetiredSounds(key: string): void {
  const retired = retiredHowlInstances[key];
  if (!retired) return;

  const remaining = retired.filter((entry) => {
    if (entry.disposed) return false;
    if (entry.subscriptions > 0 || isPlaying(entry)) return true;
    disposeEntry(entry);
    return false;
  });

  if (remaining.length > 0) retiredHowlInstances[key] = remaining;
  else delete retiredHowlInstances[key];
}

/**
 * Resolve the URL a sound is loaded from (ignoring locally downloaded copies).
 */
export function resolveSoundUrl(name: SoundName): string {
  if (isLibrarySoundName(name)) return `${cdnBaseUrl}/${manifest.sounds[name].src}`;
  return getPackSoundUrl(name) ?? name;
}

/**
 * Creates a Howl instance from a cached blob or fetches it if needed
 */
async function createOrGetHowlInstance(name: SoundName, options?: PlayerOptions): Promise<HowlEntry> {
  const key = cacheKey(name, options);

  for (;;) {
    // Return existing instance if available
    const cached = howlInstanceCache[key];
    if (cached) return cached;

    // Capture the version before loading: a pack re-registration bumps it, and a blob fetched for
    // the old URL must never end up as this sound's player.
    const version = soundVersions[name] ?? 0;

    // Fetch the blob if not already in progress. The promise is shared by every waiter.
    if (!soundBlobCache[name]) soundBlobCache[name] = fetchSoundBlob(name);
    const blobPromise = soundBlobCache[name];

    let blob: Blob;
    try {
      blob = await blobPromise;
    } catch (error) {
      // A failed load for the outdated URL must not fail a play that now targets the new URL
      if ((soundVersions[name] ?? 0) === version) throw error;
      if (soundBlobCache[name] === blobPromise) delete soundBlobCache[name];
      continue;
    }

    // Another call may have created the player while the blob was loading
    const raced = howlInstanceCache[key];
    if (raced) return raced;

    // The sound's URL changed while its blob was loading: drop the outdated data and start over
    if ((soundVersions[name] ?? 0) !== version) {
      if (soundBlobCache[name] === blobPromise) delete soundBlobCache[name];
      continue;
    }

    // Create object URL from blob
    const objectUrl = URL.createObjectURL(blob);

    // Create new Howl instance
    const howl = new Howl({
      src: [objectUrl],
      format: ["mp3"],
      // <audio> streams and keeps memory low; Web Audio (for loops) decodes the whole sound, so it can
      // repeat it without a gap
      html5: !options?.loop,
    });

    const entry: HowlEntry = { instance: howl, subscriptions: 0, objectUrl };

    // Store in cache
    howlInstanceCache[key] = entry;
    entryByHowl.set(howl, entry);

    return entry;
  }
}

/**
 * Preload multiple sounds by fetching their data without creating Howl instances
 */
export function preloadSounds(names: SoundName[]): Promise<void[]> {
  return Promise.all(
    names.map(async (name) => {
      if (!soundBlobCache[name]) {
        soundBlobCache[name] = fetchSoundBlob(name);
      }
      // Just ensure the blob is fetched but don't create Howl instance yet
      await soundBlobCache[name];
    })
  );
}

/**
 * Play a sound by name
 */
export async function playSound(name: SoundName, options?: SoundOptions): Promise<void> {
  if (!isSoundEnabled()) return;

  const player = options?.loop ? { loop: true } : undefined;
  const sound = await claimSound(name, player);
  let freed = false;

  if (options) {
    if (options.volume !== undefined) sound.volume(options.volume);
    if (options.rate !== undefined) sound.rate(options.rate);
    if (options.loop !== undefined) sound.loop(options.loop);
  }

  sound.on("end", () => {
    if (freed || options?.loop) return;
    // Release the exact player this play holds: if a hot update invalidated it meanwhile, freeing it
    // through the stale path keeps a newer player's claim intact
    if (isSoundPlayerStale(sound)) abandonStaleSound(name, player);
    else freeSound(name, player);
    freed = true;
  });

  sound.play();
}

/**
 * Check if sounds are enabled
 */
export function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return false; // Server environment not supported
  return soundEnabledGlobal;
}

/**
 * Enable or disable all sounds
 * This is used internally by the SoundProvider
 */
export function setSoundEnabled(enabled: boolean): void {
  soundEnabledGlobal = enabled;

  // Store in localStorage for persistence
  if (typeof localStorage !== "undefined") localStorage.setItem("react-sounds-enabled", enabled ? "true" : "false");

  soundStateListeners.forEach((listener) => listener(enabled));
}

/**
 * Initialize the sound enabled state
 * Called at startup to load saved preference
 */
export function initSoundEnabledState(): void {
  if (typeof localStorage === "undefined") return;

  const savedPreference = localStorage.getItem("react-sounds-enabled");
  if (savedPreference !== null) {
    soundEnabledGlobal = savedPreference !== "false";
  }
}

/**
 * Subscribe to sound enabled state changes
 */
export function subscribeSoundState(callback: (enabled: boolean) => void): () => void {
  soundStateListeners.push(callback);

  // Return unsubscribe function
  return () => {
    const index = soundStateListeners.indexOf(callback);
    if (index !== -1) soundStateListeners.splice(index, 1);
  };
}

/**
 * Get the local path for a sound when using the offline mode
 */
export async function getLocalSoundPath(name: SoundName): Promise<string | null> {
  const isPack = isPackSoundName(name);
  if (!isLibrarySoundName(name) && !isPack) return name;

  const publicPath = `/sounds/${name}.mp3`;
  // Pack files that are already served locally are loaded directly by fetchSoundBlob
  if (isPack && getPackSoundUrl(name) === publicPath) return null;

  try {
    // Add a timeout of 300ms to quickly fall back to CDN if file isn't available
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300);

    const response = await fetch(publicPath, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) return null;
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio")) return null;

    return publicPath;
  } catch (_e) { /* local file not available */ }

  return null;
}

/**
 * Clean up unused Howl instances and blob cache entries
 * Call this when running into memory constraints
 */
export function cleanupUnusedSound(name: string): void {
  const entry = howlInstanceCache[name];
  if (!entry || entry.subscriptions > 0 || isPlaying(entry)) return;

  delete howlInstanceCache[name];
  disposeEntry(entry);

  // A player that was retired by a hot update and never had subscribers is disposable too
  releaseRetiredSounds(name);
}

/**
 * Unlock the audio context globally to allow playback without direct user interaction
 */
export async function unlockAudioContext(): Promise<void> {
  if (typeof window === "undefined" || !Howler.ctx) return;
  if (Howler.ctx.state !== "suspended") return;

  try {
    await Howler.ctx.resume();
  } catch (error) {
    console.warn("Failed to unlock audio context:", error);
  }
}

/**
 * Setup global event listeners to unlock audio context on user interaction
 * Can be called multiple times safely (will only set up listeners once)
 */
export function initAudioContextUnlock(): () => void {
  if (typeof window === "undefined" || audioUnlockInitialized) return () => { /* noop */ };

  audioUnlockInitialized = true;

  const events = ["click", "touchstart", "keydown"];

  const handleInteraction = () => {
    unlockAudioContext();
    events.forEach((event) => document.removeEventListener(event, handleInteraction));
  };

  events.forEach((event) => document.addEventListener(event, handleInteraction));

  // Return cleanup function
  return () => {
    events.forEach((event) => document.removeEventListener(event, handleInteraction));
  };
}

/**
 * Check the browser's audio permission status.
 * Uses AudioContext.state to determine if audio playback is allowed.
 */
export async function checkAudioPermission(): Promise<AudioPermissionStatus> {
  if (typeof window === "undefined") return "unavailable";
  if (Howler.noAudio) return "unavailable";

  let state: string;

  if (Howler.ctx) {
    state = Howler.ctx.state;
  } else {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return "unavailable";
      const tempCtx = new AudioCtx();
      state = tempCtx.state;
      await tempCtx.close().catch(() => { /* ignore close errors */ });
    } catch {
      return "unavailable";
    }
  }

  switch (state) {
    case "running":
      return "granted";
    case "suspended":
      return "prompt";
    default:
      return "unavailable";
  }
}

/**
 * Reset all module-level state for testing purposes.
 * @internal
 */
export function __resetForTesting(): void {
  cdnBaseUrl = "https://reactsounds.sfo3.cdn.digitaloceanspaces.com/v1";
  soundEnabledGlobal = true;
  soundStateListeners.length = 0;
  audioUnlockInitialized = false;
  for (const key of Object.keys(soundBlobCache)) delete soundBlobCache[key];
  for (const key of Object.keys(howlInstanceCache)) delete howlInstanceCache[key];
  for (const key of Object.keys(retiredHowlInstances)) delete retiredHowlInstances[key];
  for (const key of Object.keys(pendingClaims)) delete pendingClaims[key];
  for (const key of Object.keys(soundVersions)) delete soundVersions[key];
  entryByHowl = new WeakMap();
  __resetPacksForTesting();
}

// Initialize sound state
initSoundEnabledState();

// Initialize audio context unlocking if we're in a browser environment
if (typeof window !== "undefined") {
  initAudioContextUnlock();
}
