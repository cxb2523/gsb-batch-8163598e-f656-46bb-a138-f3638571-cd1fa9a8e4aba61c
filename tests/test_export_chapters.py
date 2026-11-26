"""Tests for ExportManager chapter bookkeeping.

Run:  python -I tests/test_export_chapters.py -v
"""
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402  (sets SDL dummy drivers + sys.path)

from exporter import ExportManager  # noqa: E402


class FakeExport(ExportManager):
    """ExportManager without ffmpeg: only the chapter/offset bookkeeping."""

    def __init__(self):
        super().__init__(out_dir=tempfile.mkdtemp(prefix="av_export_"))
        self.is_recording = True
        self.meta_path = os.path.join(self.out_dir, "meta.txt")

    def write(self, rgb_bytes, count):
        if count > 0:
            self.frames += count
            self._last_frame = rgb_bytes


class ChapterTests(unittest.TestCase):
    def test_chapters_follow_play_order(self):
        ex = FakeExport()
        d = tempfile.mkdtemp(prefix="av_wav_")
        paths = [helpers.write_silent_wav(os.path.join(d, f"{i}.wav"), 1.0)
                 for i in range(3)]
        ex.begin_track(paths[0], 1.0, "A")
        ex.begin_track(paths[1], 1.0, "B")
        ex.begin_track(paths[2], 1.0, "C")
        self.assertEqual([t for t in ex._tracks], paths)
        self.assertEqual([c["start"] for c in ex._chapters], [0.0, 1.0, 2.0])
        self.assertEqual([c["title"] for c in ex._chapters], ["A", "B", "C"])

    def test_chapter_start_accumulates_decoded_durations(self):
        """Different real lengths (300 ms / 700 ms / 1100 ms) must add up
        exactly, independent of any prefetch delay."""
        ex = FakeExport()
        ex.begin_track("a.wav", 0.3, "a")
        ex.begin_track("b.wav", 0.7, "b")
        ex.begin_track("c.wav", 1.1, "c")
        self.assertAlmostEqual(ex._chapters[1]["start"], 0.3, places=6)
        self.assertAlmostEqual(ex._chapters[2]["start"], 1.0, places=6)

    def test_early_stop_uses_actually_played_time(self):
        ex = FakeExport()
        ex.begin_track("a.wav", 10.0, "a")
        ex.update_position(2.0)                 # stopped after 2 s
        ex.begin_track("b.wav", 5.0, "b", previous_completed=False)
        self.assertAlmostEqual(ex._chapters[1]["start"], 2.0, places=6)

    def test_natural_end_uses_full_duration(self):
        ex = FakeExport()
        ex.begin_track("a.wav", 10.0, "a")
        # sampled position may lag a few ms behind the real end
        ex.update_position(9.94)
        ex.begin_track("b.wav", 5.0, "b", previous_completed=True)
        self.assertAlmostEqual(ex._chapters[1]["start"], 10.0, places=6)

    def test_begin_track_ignored_when_not_recording(self):
        ex = FakeExport()
        ex.is_recording = False
        ex.begin_track("a.wav", 1.0, "a")
        self.assertEqual(ex._chapters, [])
        self.assertEqual(ex._tracks, [])

    def test_meta_has_one_chapter_per_track_in_order(self):
        ex = FakeExport()
        ex.begin_track("a.wav", 0.5, "A \"one\"")
        ex.begin_track("b.wav", 0.5, "B;two")
        ex.begin_track("c.wav", 0.5, "C=three")
        ex.frames = int(1.5 * ex.fps)
        ex._write_meta()
        with open(ex.meta_path, encoding="utf-8") as f:
            lines = [ln.strip() for ln in f if ln.strip()]
        chapters = [i for i, ln in enumerate(lines) if ln == "[CHAPTER]"]
        self.assertEqual(len(chapters), 3)
        titles = [ln for ln in lines if ln.startswith("title=")][1:]
        self.assertEqual(len(titles), 3)
        self.assertEqual(titles, ['title=A "one"', "title=B\\;two",
                                  "title=C\\=three"])

    def test_chapters_not_dropped_for_very_short_tracks(self):
        """Three 120 ms tracks yield three chapters with increasing starts."""
        ex = FakeExport()
        for i in range(3):
            ex.begin_track(f"{i}.wav", 0.12, str(i))
        starts = [c["start"] for c in ex._chapters]
        self.assertEqual(len(starts), 3)
        self.assertLess(starts[0], starts[1])
        self.assertLess(starts[1], starts[2])


class FullExportTests(unittest.TestCase):
    """End-to-end: real wav playlist -> real mp4 with chapters (needs ffmpeg)."""

    @classmethod
    def setUpClass(cls):
        try:
            import imageio_ffmpeg
            cls.ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            cls.ffmpeg = None
        if not cls.ffmpeg or not os.path.exists(cls.ffmpeg):
            raise unittest.SkipTest("no ffmpeg available")

    def _probe_chapters(self, path):
        """Read chapter titles back out of the mp4 via ffmetadata."""
        import re
        import subprocess
        r = subprocess.run(
            [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", path,
             "-f", "ffmetadata", "-"],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            return None
        chapters, cur = [], None
        for line in r.stdout.splitlines():
            line = line.strip()
            if line == "[CHAPTER]":
                cur = {}
                chapters.append(cur)
            elif cur is not None and "=" in line:
                k, v = line.split("=", 1)
                cur[k] = v
        return {"chapters": [{"start": int(c.get("START", 0)),
                              "end": int(c.get("END", 0)),
                              "tags": {"title": c.get("title", "")}}
                             for c in chapters]}

    def test_export_mp4_has_chapters_in_playlist_order(self):
        d = tempfile.mkdtemp(prefix="av_full_")
        names = ["Song One", "Song Two", "Song Three"]
        paths = [helpers.write_silent_wav(os.path.join(d, f"t{i}.wav"), 0.4)
                 for i in range(3)]
        ex = ExportManager(out_dir=os.path.join(d, "out"), fps=10,
                           ffmpeg_path=self.ffmpeg)
        w, h = 64, 48
        self.assertTrue(ex.start(w, h))
        frame = bytes([30, 30, 30]) * (w * h)
        for i, p in enumerate(paths):
            ex.begin_track(p, 0.4, names[i])
            # render ~0.4 s of video for this chapter
            for _ in range(5):
                time.sleep(0.09)
                ex.update_position(0.4)
                n = ex.frames_due(0.4)
                if n > 0:
                    ex.write(frame, n)
        ex.stop(natural_end=True)
        ex.wait()
        self.assertIsNotNone(ex.last_output, ex.status)
        info = self._probe_chapters(ex.last_output)
        if info is None:
            self.skipTest("ffprobe not available")
        chapters = info.get("chapters", [])
        self.assertEqual([c["tags"]["title"] for c in chapters], names)
        # starts must be strictly increasing and cover the whole video
        starts = [c["start"] for c in chapters]
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(len(set(starts)), 3)
        self.assertLessEqual(chapters[-1]["end"], int(2.0 * 1000) + 150)


if __name__ == "__main__":
    unittest.main(verbosity=2)
