import { Howl } from "howler";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  abandonStaleSound,
  checkAudioPermission,
  claimSound,
  freeSound,
  isSoundEnabled,
  isSoundPlayerStale,
  preloadSounds,
  SoundName,
  sweepRetiredSounds,
  unlockAudioContext,
} from "./runtime";
import { SoundHookReturn, SoundOptions } from "./types";

interface SoundContextType {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

// We'll get the actual context from components.tsx when using it
type SoundContextValue = React.Context<SoundContextType | null>;

// This will be set by SoundProvider from components.tsx
let SoundContext: SoundContextValue;

// Function to set the context from components.tsx
export function setSoundContext(context: SoundContextValue): void {
  SoundContext = context;
}

/**
 * Hook for using a sound in a React component.
 * Will use local bundled sounds if available before falling back to remote.
 */
export function useSound(soundName: SoundName, defaultOptions: SoundOptions = {}): SoundHookReturn {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  // One player for normal plays, one for looped plays (see PlayerOptions in runtime)
  const playersRef = useRef<Record<PlayerKind, Howl | null>>({ once: null, loop: null });
  // Players invalidated by a sound pack hot update. They are no longer used for new plays, but stay
  // claimed until their playback ends or the hook stops, so a running sound is not cut off and the
  // runtime can reclaim them afterwards.
  const stalePlayersRef = useRef<Map<Howl, PlayerKind>>(new Map());
  const activeSoundsRef = useRef<Array<{ id: number; loop: boolean; howl: Howl; resolver?: () => void }>>([]);

  // Get sound enabled state from context if available, fall back to global state
  let enabled = isSoundEnabled();
  try {
    const soundContext = SoundContext ? useContext(SoundContext) : null;
    if (soundContext) enabled = soundContext.enabled;
  } catch (_e) { /* SoundContext may not be available */ }

  // Forget a player this hook owns and release the runtime claim behind it
  const dropPlayer = useCallback((howl: Howl, kind: PlayerKind) => {
    if (playersRef.current[kind] === howl) playersRef.current[kind] = null;
    stalePlayersRef.current.delete(howl);
    release(soundName, kind, howl);
  }, [soundName]);

  // Lazy loading approach - only load the sound when needed
  const ensureLoaded = useCallback(async (kind: PlayerKind): Promise<Howl> => {
    const stealStale = (howl: Howl) => {
      // Stop handing this player out, but keep its claim and a reference so stop()/pause() still
      // control it until it ends
      if (playersRef.current[kind] === howl) playersRef.current[kind] = null;
      stalePlayersRef.current.set(howl, kind);
    };

    for (;;) {
      const existing = playersRef.current[kind];
      if (existing) {
        if (!isSoundPlayerStale(existing)) return existing;
        stealStale(existing);
      }

      const howl = await (kind === "loop" ? claimSound(soundName, { loop: true }) : claimSound(soundName));

      // The player was invalidated by a hot update while it was being loaded: drop this claim and
      // load the sound's current URL instead
      if (isSoundPlayerStale(howl)) {
        release(soundName, kind);
        continue;
      }

      // Another play finished loading meanwhile. Share its player (or, if that one in turn was
      // invalidated, retire it and keep the one just loaded).
      const current = playersRef.current[kind];
      if (current) {
        if (!isSoundPlayerStale(current)) {
          release(soundName, kind);
          return current;
        }
        stealStale(current);
      }

      // Set up event listeners
      howl.on("end", (id) => {
        const soundIndex = activeSoundsRef.current.findIndex((sound) => sound.id === id && sound.howl === howl);
        if (soundIndex >= 0) {
          const sound = activeSoundsRef.current[soundIndex];

          if (sound.resolver) sound.resolver(); // Resolve sound (eg. created in play())
          if (!sound.loop) activeSoundsRef.current.splice(soundIndex, 1);
        }

        // Free this player once none of its sounds are playing (also for a stale player kept alive
        // only for its last playback to finish)
        if (!activeSoundsRef.current.some((sound) => sound.howl === howl)) {
          if (playersRef.current[kind] === howl) {
            playersRef.current[kind] = null;
            release(soundName, kind, howl);
          } else if (stalePlayersRef.current.has(howl)) {
            dropPlayer(howl, kind);
          }
        }
        if (activeSoundsRef.current.length === 0) setIsPlaying(false);
      });

      playersRef.current[kind] = howl;
      setIsLoaded(true);
      return howl;
    }
  }, [soundName, setIsPlaying, dropPlayer]);

  const play = useCallback(
    async (options: SoundOptions = defaultOptions) => {
      if (!enabled) return;

      try {
        // Ensure audio context is unlocked before playing
        await unlockAudioContext();

        const loop = options.loop !== undefined ? options.loop : false;
        // Ensure the sound is loaded
        const howl = await ensureLoaded(loop ? "loop" : "once");

        if (options.volume !== undefined) howl.volume(options.volume);
        if (options.rate !== undefined) howl.rate(options.rate);
        howl.loop(loop);

        const id = howl.play();
        setIsPlaying(true);

        if (loop) {
          // For looped sounds, we just track them but don't resolve
          activeSoundsRef.current.push({ id, loop, howl });
          return;
        }

        // For non-looped sounds, return a promise that resolves when the sound ends
        return new Promise<void>((resolve) => {
          activeSoundsRef.current.push({ id, loop, howl, resolver: () => resolve() });
        });
      } catch (error) {
        console.error("Error playing sound:", error);
        throw error;
      }
    },
    // isLoaded is a required dep for handling changed sound name
    [defaultOptions, enabled, ensureLoaded, isLoaded]
  );

  const stopAll = useCallback(() => {
    // Resolve any pending promises
    activeSoundsRef.current.forEach((sound) => {
      if (sound.resolver) sound.resolver();
    });
    activeSoundsRef.current = [];

    // Stale players are not used for new plays, but stopping must still silence them
    for (const [howl, kind] of Array.from(stalePlayersRef.current)) {
      howl.stop();
      dropPlayer(howl, kind);
    }

    for (const kind of PLAYER_KINDS) {
      const howl = playersRef.current[kind];
      if (!howl) continue;
      howl.stop();
      playersRef.current[kind] = release(soundName, kind, howl);
    }

    // Reclaim any stale player released above once it is no longer playing
    sweepRetiredSounds(soundName);
  }, [soundName, dropPlayer]);

  const stop = useCallback(() => {
    stopAll();
    setIsPlaying(false);
  }, [stopAll]);

  const pause = useCallback(() => {
    for (const kind of PLAYER_KINDS) playersRef.current[kind]?.pause();
    stalePlayersRef.current.forEach((_kind, staleHowl) => staleHowl.pause());
    setIsPlaying(false);
  }, []);

  const resume = useCallback(() => {
    if (!enabled || activeSoundsRef.current.length === 0) return;

    // Try to unlock audio context before resuming
    unlockAudioContext().then(() => {
      activeSoundsRef.current.forEach(({ id, howl }) => howl.play(id));
      setIsPlaying(true);
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled && isPlaying) pause(); // Pause all sounds when disabled
  }, [enabled, isPlaying, pause]);

  // Cleanup on unmount
  useEffect(() => {
    preloadSounds([soundName]).then(() => setIsLoaded(true));

    return () => {
      setIsLoaded(false);
      setIsPlaying(false);
      stopAll();
    };
  }, [soundName, stopAll]);

  const checkPermission = useCallback(() => checkAudioPermission(), []);

  return { play, stop, pause, resume, isPlaying, isLoaded, checkPermission };
}

type PlayerKind = "once" | "loop";
const PLAYER_KINDS: PlayerKind[] = ["once", "loop"];

/** Free a hook's player; returns null to clear the ref */
function release(soundName: SoundName, kind: PlayerKind, howl?: Howl): null {
  const stale = howl ? isSoundPlayerStale(howl) : false;
  if (kind === "loop") {
    // A player invalidated by a hot update is released through the stale path so it never takes the
    // release meant for a newer player of the same sound
    return stale ? abandonStaleSound(soundName, { loop: true }) : freeSound(soundName, { loop: true });
  }
  return stale ? abandonStaleSound(soundName) : freeSound(soundName);
}

interface UseSoundOnChangeOptions extends SoundOptions {
  initial?: boolean;
}

/**
 * Hook for playing a sound when a value changes
 */
export function useSoundOnChange<T>(soundName: SoundName, value: T, options?: UseSoundOnChangeOptions): void {
  const { play } = useSound(soundName);
  const initialRef = useRef(true);

  useEffect(() => {
    const skipThisInitialRun = initialRef.current && options?.initial === false;
    initialRef.current = false;
    if (skipThisInitialRun) return;

    play(options).catch((err) => console.error("Failed to play sound:", err));
  }, [value]);
}

/**
 * Hook for accessing and controlling the sound enabled state
 */
export function useSoundEnabled(): [boolean, (enabled: boolean) => void] {
  const context = useContext(SoundContext);
  if (!context) throw new Error("useSoundEnabled must be used within a SoundProvider");

  return [context.enabled, context.setEnabled];
}
