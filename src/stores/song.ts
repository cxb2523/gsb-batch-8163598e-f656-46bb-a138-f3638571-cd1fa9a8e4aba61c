import Player from "@/audio/play";
import { SampleTrack } from "@/audio/track";
import { defineStore } from "pinia";
import { reactive, ref } from "vue";

class Audio {
  private _context?: AudioContext;
  private _gainNode?: GainNode;
  private _gainConnected = false;

  // Browsers require an audio context to start or resume after a
  // user event. For more information, visit https://goo.gl/7K7WLu.
  context(): AudioContext {
    if (this._context === undefined) {
      this._context = new AudioContext();
    }
    return this._context;
  }

  gainNode(): GainNode {
    if (this._gainNode === undefined) {
      this._gainNode = this.context().createGain();
    }
    return this._gainNode;
  }

  /**
   * Routes the gain node to the context destination exactly once. Repeated
   * playback toggles never stack additional connections, so gains cannot
   * compound.
   */
  connectDestination(): GainNode {
    const gainNode = this.gainNode();
    if (!this._gainConnected) {
      gainNode.connect(this.context().destination);
      this._gainConnected = true;
    }
    return gainNode;
  }
}

export const useSongStore = defineStore("song", () => {
  const audio = new Audio();
  const alert = reactive({ message: "", type: "error" });
  const player = ref(new Player(16, 1 / 16, 0.075, 120.0, 0.025));
  const tempo = ref(120);
  const tracks = reactive([
    new SampleTrack("Kick", "data/kick.wav", player.value.length),
    new SampleTrack("Snare", "data/snare.wav", player.value.length),
    new SampleTrack("Mid-Tom", "data/tom.wav", player.value.length),
    new SampleTrack("Hi-Hat", "data/hi_hat.wav", player.value.length),
  ]);
  const volume = ref(100.0);

  function resetAlert(): void {
    alert.message = "";
  }

  async function loadSamples(): Promise<void> {
    await Promise.all(tracks.map((track) => track.loadSample(audio.context())));
  }

  function setTempo(value: number): void {
    tempo.value = value;
    // Only the field changes: the running scheduler reads `player.tempo` on
    // its next lookahead tick, so subsequently scheduled steps use the new
    // tempo without restarting the chain or retriggering the current step.
    player.value.tempo = value;
  }

  function setVolume(value: number): void {
    volume.value = value;
    audio.gainNode().gain.value = value / 100.0;
  }

  function playNote(trackName: string): void {
    const context = audio.context();
    context.resume();
    const gainNode = audio.connectDestination();

    const track = tracks.filter((track) => track.name == trackName)[0];
    track.note(context, gainNode, 0.0);
  }

  function toggleNoteActive(trackName: string, noteIndex: number): void {
    const track = tracks.filter((track) => track.name == trackName)[0];
    track.notes[noteIndex].active = !track.notes[noteIndex].active;
  }

  function togglePlaying(): void {
    if (player.value.isPlaying) {
      player.value.pause();
      return;
    }

    if (tempo.value <= 0) {
      alert.message = "Tempo must be a postive number";
      alert.type = "error";
      return;
    }

    const context = audio.context();
    context.resume();
    const gainNode = audio.connectDestination();
    // `start` is a no-op while already playing, so rapid clicks cannot create
    // a parallel scheduling chain; resuming reuses the retained step phase.
    player.value.start(context, gainNode, tracks);
  }

  /** Stops playback and releases every scheduler timer on unmount. */
  function dispose(): void {
    player.value.dispose();
  }

  return {
    alert,
    audio,
    dispose,
    loadSamples,
    player,
    playNote,
    resetAlert,
    setTempo,
    setVolume,
    tempo,
    toggleNoteActive,
    togglePlaying,
    tracks,
    volume,
  };
});
