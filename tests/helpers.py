"""Shared helpers for the prefetch / export verification tests.

These tests run against the real project modules (fileprocessor.py,
exporter.py) with pygame's dummy video/audio drivers, so they need no
window, no sound card and no user interaction.

Usage:
    python -I tests/test_prefetch_export.py -v
"""
import os
import struct
import sys
import time
import wave

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO not in sys.path:
    sys.path.insert(0, REPO)


def write_silent_wav(path, seconds, sr=44100):
    """Creates a mono 16-bit silent WAV of the requested length."""
    frames = int(round(seconds * sr))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00" * frames)
    return path


def wait_until(predicate, timeout=20.0, interval=0.02, what="condition"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    raise AssertionError(f"timeout waiting for {what}")


def drain_serial(fp, seconds=0.5):
    """Runs fp.update() in a tight loop so finishing tracks advance."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        fp.update()
        time.sleep(0.01)


class SlowAnalyzer:
    """Replaces FileProcessor._analyze with a controllable one.

    Paths listed in `block` wait for `gate` before the real analysis runs,
    which simulates "pre-analysis finishes only after the user switched
    tracks".
    """

    def __init__(self, real_analyze):
        import threading
        self._real = real_analyze
        self.calls = []          # paths in call order
        self.block = set()       # paths that block until gate is set
        self.gate = threading.Event()
        self.gate.set()
        self._lock = threading.Lock()

    def __call__(self, path):
        with self._lock:
            self.calls.append(path)
        if path in self.block:
            self.gate.wait(30)
        return self._real(path)

