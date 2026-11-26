"""End-to-end test of the main-loop glue between FileProcessor and the export.

It drives the real FileProcessor playback flow (including prefetch and fast
track switches) while feeding all track starts into a real ExportManager and
then checks the produced mp4's chapters against the playlist order.

Run:  python -I tests/test_export_integration.py -v
"""
import os
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402  (sets SDL dummy drivers + sys.path)

import pygame  # noqa: E402
from fileprocessor import FileProcessor  # noqa: E402
from exporter import ExportManager  # noqa: E402


def setUpModule():
    pygame.mixer.init()


def tearDownModule():
    pygame.mixer.quit()


def read_ffmpeg():
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        return exe if exe and os.path.exists(exe) else None
    except Exception:
        return None


def report_starts(fp, ex):
    """Same chapter reporting as HotVisualizer.run()."""
    for ev in fp.pop_start_events():
        if ex.is_recording:
            label = (f"{ev['artist']} - {ev['title']}"
                     if ev['artist'] else ev['title'])
            ex.begin_track(ev['path'], ev['duration'], label,
                           ev['previous_natural_end'])


def pump(fp, ex, seconds, frame=None):
    """Simulates the main loop: playback, chapter reporting, frame feed."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        fp.update()
        err = fp.pop_error()
        assert not err, err
        report_starts(fp, ex)
        if ex.is_recording:
            pos = fp.get_position()
            ex.update_position(pos)
            if frame is not None:
                n = ex.frames_due(pos)
                if n > 0:
                    ex.write(frame, n)
        time.sleep(0.01)


def run_until_playlist_end(fp, ex, timeout=15, frame=None):
    end = time.time() + timeout
    while time.time() < end and not fp.ended_all:
        pump(fp, ex, 0.02, frame=frame)
    return fp.ended_all


class ExportIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = read_ffmpeg()
        if not cls.ffmpeg:
            raise unittest.SkipTest("no ffmpeg available")

    def _chapters(self, path):
        r = subprocess.run(
            [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", path,
             "-f", "ffmetadata", "-"],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        self.assertEqual(r.returncode, 0, r.stderr)
        out, cur = [], None
        for line in r.stdout.splitlines():
            line = line.strip()
            if line == "[CHAPTER]":
                cur = {}
                out.append(cur)
            elif cur is not None and "=" in line:
                k, v = line.split("=", 1)
                cur[k] = v
        return out

    def test_fast_switching_during_export_keeps_chapter_order(self):
        d = tempfile.mkdtemp(prefix="av_int_")
        paths = [helpers.write_silent_wav(os.path.join(d, f"trk{i}.wav"), 0.5)
                 for i in range(4)]

        fp = FileProcessor()
        ex = ExportManager(out_dir=os.path.join(d, "out"), fps=10,
                           ffmpeg_path=self.ffmpeg)
        self.assertTrue(ex.start(64, 48))
        frame = bytes([20, 20, 20]) * (64 * 48)

        try:
            fp.set_playlist(paths, autoplay=True)
            helpers.wait_until(
                lambda: fp.is_analyzed and not fp.loading
                and fp.file_path == paths[0], what="first track")
            fp.discard_start_events()
            fp.restart_track()          # what start_export() does

            self.assertTrue(run_until_playlist_end(fp, ex, frame=frame),
                            "playlist did not finish")
            ex.stop(natural_end=True)
            ex.wait()
        finally:
            fp.stop()

        self.assertIsNotNone(ex.last_output, ex.status)
        chapters = self._chapters(ex.last_output)
        titles = [c.get("title") for c in chapters]
        self.assertEqual(titles, [f"trk{i}" for i in range(4)])

        starts = [int(c["START"]) for c in chapters]
        self.assertEqual(starts, sorted(starts))
        # 4 x 0.5 s, one mp4, each chapter starts where the previous ended
        for i in range(1, len(chapters)):
            self.assertAlmostEqual(starts[i], int(0.5 * 1000 * i), delta=60)

    def test_appending_while_exporting_extends_in_order(self):
        d = tempfile.mkdtemp(prefix="av_int_app_")
        first = [helpers.write_silent_wav(os.path.join(d, f"a{i}.wav"), 0.4)
                 for i in range(2)]
        more = [helpers.write_silent_wav(os.path.join(d, f"b{i}.wav"), 0.4)
                for i in range(2)]

        fp = FileProcessor()
        ex = ExportManager(out_dir=os.path.join(d, "out"), fps=10,
                           ffmpeg_path=self.ffmpeg)
        self.assertTrue(ex.start(64, 48))
        frame = bytes([10, 25, 40]) * (64 * 48)

        try:
            fp.set_playlist(first, autoplay=True)
            helpers.wait_until(lambda: fp.is_analyzed, what="first track")
            fp.discard_start_events()
            fp.restart_track()

            pump(fp, ex, 0.15, frame=frame)
            fp.add_to_playlist(more)         # shift+A during the export
            self.assertTrue(run_until_playlist_end(fp, ex, frame=frame),
                            "playlist did not finish")
            ex.stop(natural_end=True)
            ex.wait()
        finally:
            fp.stop()

        titles = [c.get("title") for c in self._chapters(ex.last_output)]
        self.assertEqual(titles, ["a0", "a1", "b0", "b1"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
