# -----------------------------------------------------------------------------
#  Awesome-Audio-Visualizer 1.1.0 by Volkan Sah
#  Copyright (c) 2024-2025 Volkan Sah
#  License:      AGPL-3.0-or-later (siehe LICENSE)
#  https://github.com/VolkanSah/Awesome-Audio-Visualizer
# -----------------------------------------------------------------------------
# 2. Audio FileProcessor: class FileProcessor  (playlist capable)
# File: fileprocessor.py
# -----------------------------------------------------------------------------
import os
import threading

import numpy as np
import pygame
import librosa

AUDIO_EXTS = ('.mp3', '.wav', '.ogg', '.flac')


def collect_audio_files(paths):
    """Expands files and folders into a sorted list of playable audio files."""
    result = []
    for p in paths:
        if os.path.isdir(p):
            for root, _, files in os.walk(p):
                for name in sorted(files):
                    if name.lower().endswith(AUDIO_EXTS):
                        result.append(os.path.join(root, name))
        elif os.path.isfile(p) and p.lower().endswith(AUDIO_EXTS):
            result.append(p)
    return result


class _PrefetchJob:
    """One background analysis of a future track.

    A job is only allowed to fill the prefetch cache while it is still the
    current playlist's next track (path, index and playlist epoch all match)
    and nobody has claimed its result for the current track in the meantime.
    """

    __slots__ = ("path", "index", "epoch", "result", "error",
                 "claimed", "done")

    def __init__(self, path, index, epoch):
        self.path = path
        self.index = index
        self.epoch = epoch
        self.result = None
        self.error = None
        self.claimed = False
        self.done = threading.Event()


def read_tags(path):
    """Returns (title, artist). Uses mutagen if installed, else the file name
    ('Artist - Title.mp3' is understood)."""
    title = artist = ""
    try:
        import mutagen
        tags = mutagen.File(path, easy=True)
        if tags:
            title = (tags.get('title') or [''])[0]
            artist = (tags.get('artist') or [''])[0]
    except Exception:
        pass
    if not title:
        stem = os.path.splitext(os.path.basename(path))[0]
        if ' - ' in stem:
            a, t = stem.split(' - ', 1)
            artist = artist or a.strip()
            title = t.strip()
        else:
            title = stem
    return title.strip(), artist.strip()


class FileProcessor:
    def __init__(self):
        pygame.mixer.init()
        # playlist
        self.playlist = []
        self.index = -1
        # current track
        self.file_path = None
        self.title = ""
        self.artist = ""
        self.log_spectrogram = None
        self.beat_times = []
        self.duration = 0
        self.sr = 44100
        # state
        self.is_analyzed = False
        self.loading = False
        self.load_failed = False
        self.error_msg = ""
        self.playback_state = 'stopped'  # 'stopped', 'playing', 'paused'
        self.ended_all = False           # True when the last track ran out
        self.track_serial = 0            # +1 every time a track starts at 0:00
        self.beats_detected = 0
        self.beat_index = 0
        # Track starts that the UI still has to report (e.g. export chapters).
        # Kept in order so a fast chain of very short tracks cannot be missed.
        self._start_events = []
        self._start_lock = threading.Lock()
        # True when the track that started last ran into its natural end.
        # A manual skip (N/B/A/K + reload) leaves it False so an export can
        # advance the chapter by the actually played time instead.
        self._last_natural_end = True
        # background pre-analysis of the next track (no gap between songs)
        self._cache = {}                 # path -> analysis, at most ONE entry
        self._cache_lock = threading.RLock()
        self._prefetch_job = None        # _PrefetchJob for the next track
        self._epoch = 0                  # bumps when prefetch results go stale
        self._load_token = 0             # bumps on every play_index switch

    # ------------------------------------------------------------ analysis
    def _analyze(self, path):
        audio_data, sr = librosa.load(path, sr=self.sr, mono=True)
        duration = librosa.get_duration(y=audio_data, sr=sr)
        _, beat_frames = librosa.beat.beat_track(y=audio_data, sr=sr)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr)
        spectrogram = np.abs(librosa.stft(audio_data, n_fft=2 * 1024, hop_length=1024))
        log_spec = librosa.amplitude_to_db(spectrogram, ref=np.max)
        title, artist = read_tags(path)
        return {'path': path, 'sr': sr, 'duration': duration, 'beat_times': beat_times,
                'log_spectrogram': log_spec, 'title': title, 'artist': artist}

    def _activate(self, data, autoplay, token=None):
        # Serialised with play_index: a superseded load must not hijack the
        # mixer or clear `loading` while a newer track is being prepared.
        with self._cache_lock:
            if token is not None and token != self._load_token:
                return False
            self.file_path = data['path']
            self.sr = data['sr']
            self.duration = data['duration']
            self.beat_times = data['beat_times']
            self.log_spectrogram = data['log_spectrogram']
            self.title = data['title']
            self.artist = data['artist']
            pygame.mixer.music.load(data['path'])
            self.playback_state = 'stopped'
            self.is_analyzed = True
            self.loading = False
            if autoplay:
                self._play_from_start()
            self._start_prefetch()
        return True

    def _play_from_start(self):
        self.beat_index = 0
        self.beats_detected = 0
        self.ended_all = False
        pygame.mixer.music.play()
        self.playback_state = 'playing'
        self.track_serial += 1
        # Snapshot everything needed to report this start (export chapters).
        # Keeping it here means a later switch can never make an older start
        # report the wrong track, and several very short tracks cannot be
        # collapsed into a single report anymore.
        with self._start_lock:
            self._start_events.append({
                'serial': self.track_serial,
                'path': self.file_path,
                'duration': self.duration,
                'title': self.title,
                'artist': self.artist,
                'previous_natural_end': self._last_natural_end,
            })
            # Bounded: if nobody consumes the events (no export ever runs)
            # the list must not grow for the lifetime of the app.
            if len(self._start_events) > 64:
                del self._start_events[:-64]
            self._last_natural_end = False

    def pop_start_events(self):
        """Returns and clears all track starts not yet reported, in order."""
        with self._start_lock:
            events, self._start_events = self._start_events, []
        return events

    def discard_start_events(self):
        """Drops unreported starts (e.g. before a new export begins)."""
        with self._start_lock:
            self._start_events = []

    # ------------------------------------------------------------ prefetch
    def _start_prefetch(self):
        with self._cache_lock:
            nxt = self.index + 1
            if not (0 <= nxt < len(self.playlist)):
                return
            path = self.playlist[nxt]
            if path in self._cache:
                return                       # already analysed and still valid
            job = self._prefetch_job
            if (job is not None and not job.claimed and job.path == path
                    and job.index == nxt and job.epoch == self._epoch
                    and not job.done.is_set()):
                return                       # the same analysis is still running
            job = _PrefetchJob(path, nxt, self._epoch)
            self._prefetch_job = job

        def task():
            try:
                data = self._analyze(job.path)
            except Exception as e:
                job.error = e
                print(f"Prefetch fehlgeschlagen ({os.path.basename(job.path)}): {e}")
            else:
                job.result = data
                with self._cache_lock:
                    # Write back ONLY if this job still analyses the next
                    # track of the current playlist. A stale thread finishing
                    # after a switch/add/replace is discarded here.
                    if (not job.claimed and job.epoch == self._epoch
                            and job.index == self.index + 1
                            and 0 <= job.index < len(self.playlist)
                            and self.playlist[job.index] == job.path):
                        self._cache = {job.path: data}   # keep only one track
            finally:
                job.done.set()
                with self._cache_lock:
                    if self._prefetch_job is job:
                        self._prefetch_job = None

        threading.Thread(target=task, daemon=True).start()

    # ------------------------------------------------------------ playlist
    def set_playlist(self, paths, autoplay=True):
        """Replaces the playlist and starts the first track."""
        if self.loading:
            return False
        pygame.mixer.music.stop()
        self.playback_state = 'stopped'
        with self._cache_lock:
            self.playlist = list(paths)
            # Atomic with the replacement: nothing analysed for the old list
            # may be written back or reused for the new one.
            self._epoch += 1
            self._cache = {}
            self._prefetch_job = None
        return self.play_index(0, autoplay)

    def add_to_playlist(self, paths):
        old_len = len(self.playlist)
        with self._cache_lock:
            self.playlist.extend(paths)
            # The playlist state changed: analysis started for the old state
            # must not be written back or reused, even if the path is the
            # same (the "next track" position may now be a different one).
            self._epoch += 1
            self._cache = {}
            self._prefetch_job = None
        if not self.playlist:
            return
        if old_len == 0:
            self.play_index(0, True)
        elif self.ended_all and not self.loading:   # list was finished -> continue
            self.play_index(old_len, True)
        elif not self.loading:
            self._start_prefetch()

    def play_index(self, i, autoplay=True):
        if self.loading or not (0 <= i < len(self.playlist)):
            return False
        path = self.playlist[i]
        pygame.mixer.music.stop()
        self.playback_state = 'stopped'

        with self._cache_lock:
            # index and cache change together: the cache may only ever hold
            # the track that follows the *current* index.
            self.index = i
            self.is_analyzed = False
            self.load_failed = False
            self.loading = True
            self._load_token += 1
            token = self._load_token
            # Everything analysed before this switch must not be trusted
            # anymore: old prefetch threads may still be running.
            self._epoch += 1
            data = self._cache.pop(path, None)
            self._cache = {}
            job = self._prefetch_job
            if (job is not None and not job.claimed and job.path == path
                    and not job.done.is_set()):
                job.claimed = True            # this load takes the result
                claim = job
            else:
                claim = None
            self._prefetch_job = None

        def task():
            try:
                if claim is not None:
                    claim.done.wait()
                    data2 = claim.result if claim.error is None else None
                else:
                    data2 = data
                if data2 is None:
                    print(f"Lade und analysiere '{os.path.basename(path)}' ...")
                    data2 = self._analyze(path)
                with self._cache_lock:
                    if token != self._load_token:
                        return                # superseded by a newer switch
                    self._cache = {}          # consumed -> never reused
                self._activate(data2, autoplay, token)
            except Exception as e:
                self.error_msg = f"Fehler bei '{os.path.basename(path)}': {e}"
                print(self.error_msg)
                with self._cache_lock:
                    if token != self._load_token:
                        return
                    self.is_analyzed = False
                    self.loading = False
                    self.load_failed = True

        threading.Thread(target=task, daemon=True).start()
        return True

    def next_track(self):
        if self.index + 1 < len(self.playlist):
            return self.play_index(self.index + 1, True)
        return False

    def prev_track(self):
        pos = self.get_position()
        if self.index <= 0 or (pos is not None and pos > 3.0):
            self.restart_track()
        else:
            self.play_index(self.index - 1, True)

    def restart_track(self):
        """Plays the current track from 0:00 (used by export)."""
        if not self.is_analyzed or self.loading:
            return
        pygame.mixer.music.stop()
        self._play_from_start()

    def update(self):
        """Call once per frame: handles track end -> next track."""
        if self.load_failed:
            self.load_failed = False
            if self.index + 1 < len(self.playlist):
                self.play_index(self.index + 1, True)
            else:
                self.playback_state = 'stopped'
                self.ended_all = True
            return
        if (self.playback_state == 'playing' and not self.loading
                and not pygame.mixer.music.get_busy()):
            self.playback_state = 'stopped'
            # The track ran to its end on its own -> its full (decoded)
            # duration is part of the export's audio timeline.
            self._last_natural_end = True
            if self.index + 1 < len(self.playlist):
                self.play_index(self.index + 1, True)
            else:
                self.ended_all = True

    def pop_error(self):
        msg, self.error_msg = self.error_msg, ""
        return msg

    def playlist_info(self):
        return self.index + 1, len(self.playlist)

    # ------------------------------------------------------------ playback
    def toggle_play_pause(self):
        if not self.is_analyzed:
            return
        if self.playback_state == 'playing':
            pygame.mixer.music.pause()
            self.playback_state = 'paused'
        elif self.playback_state == 'paused':
            pygame.mixer.music.unpause()
            self.playback_state = 'playing'
        elif self.playback_state == 'stopped':
            self._play_from_start()

    def stop(self):
        """Stops playback (P starts the current track again from the start)."""
        if not self.is_analyzed:
            return
        pygame.mixer.music.stop()
        self.playback_state = 'stopped'

    def get_position(self):
        """Seconds since the track started (pause not counted) or None."""
        if self.playback_state in ('playing', 'paused') and self.is_analyzed:
            ms = pygame.mixer.music.get_pos()
            if ms >= 0:
                return min(ms / 1000.0, self.duration)
        return None

    def get_all_audio_data(self):
        if not self.is_analyzed or self.log_spectrogram is None:
            return np.zeros(1024), False, 0, 0
        if self.playback_state != 'playing' or self.duration == 0:
            return np.zeros(self.log_spectrogram.shape[0]), False, 0, 0

        current_time = max(pygame.mixer.music.get_pos(), 0) / 1000.0
        frame_index = int(current_time * self.log_spectrogram.shape[1] / self.duration)
        frame_index = min(max(0, frame_index), self.log_spectrogram.shape[1] - 1)

        fft_data = self.log_spectrogram[:, frame_index]
        fft_data = np.interp(fft_data, (fft_data.min(), fft_data.max()), (0, 100))

        is_beat = False
        if self.beat_index < len(self.beat_times) and current_time >= self.beat_times[self.beat_index]:
            is_beat = True
            self.beat_index += 1
            self.beats_detected += 1

        return fft_data, is_beat, np.mean(fft_data), np.max(fft_data)

    def get_beat_stats(self):
        pos = self.get_position()
        if pos and pos > 0 and self.beats_detected > 0:
            bpm = self.beats_detected / (pos / 60)
        else:
            bpm = 0
        return self.beats_detected, int(bpm)
