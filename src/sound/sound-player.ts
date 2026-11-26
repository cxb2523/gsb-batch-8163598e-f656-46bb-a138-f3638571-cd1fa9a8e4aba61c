import { check, DEV } from "../development-checks"
import { hasUserActivation, isBrowser } from "../environment"
import type { SoundConfig, SoundName, SoundOptions } from "../schema"
import { applySoundConfig, isSoundEnabled, soundPreference, soundVolume } from "./sound-store"

export type { SoundConfig, SoundName, SoundOptions }

type SoundEngine = typeof import("./sound-engine")

const noop = () => {}
let engine: Promise<SoundEngine> | null = null

function loadEngine(): Promise<SoundEngine> {
  if (engine) return engine
  const loading = import("./sound-engine").then((loaded) => {
    loaded.setVolume(soundVolume())
    return loaded
  })
  loading.catch(() => {
    if (engine === loading) engine = null
  })
  engine = loading
  return loading
}

const withEngine = (run: (loaded: SoundEngine) => void): void => {
  engine?.then(run, noop)
}

if (isBrowser()) {
  soundPreference.subscribe(() => {
    if (!isSoundEnabled()) withEngine((loaded) => loaded.silence())
  })
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") withEngine((loaded) => loaded.suspend())
    else if (isSoundEnabled()) withEngine((loaded) => loaded.resume())
  })
}

export function configureSound(next: SoundConfig): void {
  if (DEV) check("soundConfig", next, "configureSound() was given settings it cannot use")
  applySoundConfig(next)
  withEngine((loaded) => loaded.setVolume(soundVolume()))
}

export function primeSound(): void {
  if (!engine && isBrowser() && isSoundEnabled()) loadEngine().catch(noop)
}

export function playSound(name: SoundName, options?: SoundOptions): () => void {
  if (DEV) check("soundName", name, `playSound("${String(name)}") is not a sound isokit has`)
  if (DEV && options) check("soundOptions", options, `playSound("${String(name)}") was given options it cannot use`)
  if (!isBrowser() || !isSoundEnabled() || !hasUserActivation()) return noop
  let stopped = false
  let stop = noop
  loadEngine().then((loaded) => {
    if (stopped) return
    if (!isSoundEnabled()) return
    stop = loaded.play(name, options)
  }, noop)
  return () => {
    stopped = true
    stop()
  }
}
