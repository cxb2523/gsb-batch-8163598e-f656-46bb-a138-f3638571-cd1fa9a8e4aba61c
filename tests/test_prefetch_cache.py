"""Tests for FileProcessor prefetch cache invalidation and track-start events.

Run:  python -I tests/test_prefetch_cache.py -v
"""
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402  (sets SDL dummy drivers + sys.path)

import pygame  # noqa: E402
from fileprocessor import FileProcessor  # noqa: E402


def setUpModule():
    pygame.mixer.init()


def tearDownModule():
    pygame.mixer.quit()


class PrefetchCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="av_prefetch_")
        self.paths = [helpers.write_silent_wav(
            os.path.join(self.tmp, f"track{i}.wav"), 0.6) for i in range(4)]
        self.fp = FileProcessor()
        self._real = self.fp._analyze
        self.analyzer = helpers.SlowAnalyzer(self._real)
        self.fp._analyze = self.analyzer

    def tearDown(self):
        with self.fp._cache_lock:
            self.fp._epoch += 1
            self.fp._cache = {}
            self.fp._prefetch_job = None

    def drop_prefetch(self):
        with self.fp._cache_lock:
            self.fp._epoch += 1
            self.fp._cache = {}
            self.fp._prefetch_job = None

    # ------------------------------------------------------------------ utils
    def wait_loaded(self, path, timeout=20):
        helpers.wait_until(
            lambda: (not self.fp.loading and self.fp.is_analyzed
                     and self.fp.file_path == path),
            timeout=timeout, what=f"loading {path}")

    def cache_paths(self):
        with self.fp._cache_lock:
            return set(self.fp._cache.keys())

    # ----------------------------------------------------------------- tests
    def test_cache_holds_only_the_next_track(self):
        self.fp.set_playlist(self.paths, autoplay=False)
        self.wait_loaded(self.paths[0])
        helpers.wait_until(lambda: self.cache_paths() == {self.paths[1]},
                           what="prefetch of track 1")
        self.assertEqual(self.cache_paths(), {self.paths[1]})

    def test_cache_is_consumed_by_the_next_load(self):
        self.fp.set_playlist(self.paths, autoplay=False)
        self.wait_loaded(self.paths[0])
        helpers.wait_until(lambda: self.cache_paths() == {self.paths[1]},
                           what="prefetch of track 1")
        self.assertTrue(self.fp.next_track())
        self.wait_loaded(self.paths[1])
        # consumed -> never reused; the new cache belongs to track 2
        with self.fp._cache_lock:
            self.assertNotIn(self.paths[1], self.fp._cache)
        helpers.wait_until(lambda: self.cache_paths() == {self.paths[2]},
                           what="prefetch of track 2")

    def test_fast_switch_never_leaves_stale_entry(self):
        """Rapid N presses: the cache must only ever contain the track that is
        the next one for the *current* index (checked atomically)."""
        self.fp.set_playlist(self.paths, autoplay=False)
        self.wait_loaded(self.paths[0])

        def bad_snapshots():
            bad = []
            with self.fp._cache_lock:
                idx, playlist = self.fp.index, list(self.fp.playlist)
                cached = set(self.fp._cache)
            expected = ({playlist[idx + 1]}
                        if 0 <= idx + 1 < len(playlist) else set())
            if not cached <= expected:
                bad.append((idx, cached, expected))
            return bad

        violations = []
        for _ in range(3):
            self.fp.next_track()
            for _ in range(8):
                violations += bad_snapshots()
                time.sleep(0.01)
            self.wait_loaded(self.fp.playlist[self.fp.index])
        helpers.wait_until(lambda: self.fp.index == 3, what="index 3")
        violations += bad_snapshots()
        self.assertEqual(violations, [], "cache held a non-next-track entry")
        # last track -> no next track -> nothing may be cached
        self.assertEqual(self.cache_paths(), set())

    def test_stale_prefetch_after_switch_is_discarded(self):
        """Negative test: the old prefetch finishes only after the switch and
        must not write its result into the cache."""
        self.fp.set_playlist(self.paths, autoplay=False)
        self.wait_loaded(self.paths[0])
        # track 1 prefetch starts and blocks
        self.analyzer.block.add(self.paths[1])
        self.analyzer.gate = threading.Event()
        self.drop_prefetch()                # drop the already running job
        self.fp._start_prefetch()           # new job for track 1, now blocked
        helpers.wait_until(lambda: self.paths[1] in self.analyzer.calls,
                           what="blocked prefetch")
        # switch away while the track-1 analysis is still blocked
        self.assertTrue(self.fp.next_track())   # -> track 1 is loading now
        time.sleep(0.15)
        self.fp.loading = False             # simulate a superseded load
        self.drop_prefetch()                # as a later switch would do
        self.fp.index = 3
        # now let the stale analysis finish
        self.analyzer.gate.set()
        deadline = time.time() + 5
        while time.time() < deadline and not self.fp._prefetch_job is None:
            time.sleep(0.02)
        time.sleep(0.2)
        # the stale result must NOT be cached as the next track
        self.assertNotIn(self.paths[1], self.cache_paths())
        self.assertEqual(self.cache_paths(), set())

    def test_stale_prefetch_does_not_touch_the_active_track(self):
        """A prefetch finishing after a jump must neither cache its result
        nor overwrite the analysis data of the now-playing track."""
        self.fp.set_playlist(self.paths, autoplay=True)
        self.wait_loaded(self.paths[0])
        self.analyzer.block.add(self.paths[1])
        self.analyzer.gate = threading.Event()
        self.fp._start_prefetch()
        helpers.wait_until(
            lambda: self.paths[1] in self.analyzer.calls, what="blocked job")

        self.assertTrue(self.fp.play_index(2))       # jump to track 2
        self.wait_loaded(self.paths[2])
        active_dur = self.fp.duration
        active_path = self.fp.file_path

        self.analyzer.gate.set()                     # stale job completes late
        time.sleep(0.4)
        self.assertEqual(self.fp.file_path, active_path)
        self.assertEqual(self.fp.duration, active_dur)
        self.assertNotIn(self.paths[1], self.cache_paths())
        # next of track 2 is track 3 and may be the only cache entry
        self.assertTrue(self.cache_paths() <= {self.paths[3]})

    def test_replace_playlist_drops_inflight_prefetch(self):
        self.fp.set_playlist(self.paths, autoplay=True)
        self.wait_loaded(self.paths[0])
        self.analyzer.block.add(self.paths[1])
        self.analyzer.gate = threading.Event()
        self.fp._start_prefetch()
        helpers.wait_until(
            lambda: self.paths[1] in self.analyzer.calls, what="blocked job")

        other = [helpers.write_silent_wav(
            os.path.join(self.tmp, f"r{i}.wav"), 0.5) for i in range(2)]
        self.assertTrue(self.fp.set_playlist(other, autoplay=True))
        self.wait_loaded(other[0])
        self.analyzer.gate.set()
        time.sleep(0.4)
        self.assertNotIn(self.paths[1], self.cache_paths())
        helpers.wait_until(lambda: self.cache_paths() <= {other[1]},
                           what="only the new next track may be cached")

    def test_multiple_track_starts_are_all_reported_in_order(self):
        """Fast chain of short tracks: every start is reported exactly once."""
        paths = [helpers.write_silent_wav(
            os.path.join(self.tmp, f"s{i}.wav"), 0.25) for i in range(3)]
        self.fp.set_playlist(paths, autoplay=True)
        self.wait_loaded(paths[0])
        helpers.drain_serial(self.fp, seconds=1.6)
        events = []
        # collect while the list is running to the end
        deadline = time.time() + 2
        while time.time() < deadline:
            events.extend(self.fp.pop_start_events())
            self.fp.update()
            time.sleep(0.01)
        events.extend(self.fp.pop_start_events())
        got = [e["path"] for e in events]
        self.assertEqual(got, paths, "start events out of order or missing")
        self.assertEqual(len(set(e["serial"] for e in events)), len(events))

    def test_discard_start_events_drops_pending(self):
        self.fp.set_playlist(self.paths, autoplay=True)
        self.wait_loaded(self.paths[0])
        helpers.wait_until(lambda: len(self.fp._start_events) >= 1,
                           what="start event")
        self.fp.discard_start_events()
        self.assertEqual(self.fp.pop_start_events(), [])

    def test_add_to_playlist_invalidates_old_cache(self):
        self.fp.set_playlist(self.paths[:2], autoplay=False)
        self.wait_loaded(self.paths[0])
        helpers.wait_until(lambda: self.cache_paths() == {self.paths[1]},
                           what="prefetch track 1")
        self.fp.add_to_playlist(self.paths[2:])
        # the appended list changed the playlist epoch; the old entry is gone
        with self.fp._cache_lock:
            self.assertEqual(self.fp._cache, {})
        helpers.wait_until(lambda: self.cache_paths() == {self.paths[1]},
                           what="re-prefetch track 1")

    def test_set_playlist_invalidates_old_cache(self):
        self.fp.set_playlist(self.paths, autoplay=False)
        self.wait_loaded(self.paths[0])
        helpers.wait_until(lambda: self.cache_paths() == {self.paths[1]},
                           what="prefetch track 1")
        other = [helpers.write_silent_wav(
            os.path.join(self.tmp, f"o{i}.wav"), 0.5) for i in range(2)]
        self.fp.set_playlist(other, autoplay=False)
        self.wait_loaded(other[0])
        self.assertNotIn(self.paths[1], self.cache_paths())
        helpers.wait_until(lambda: self.cache_paths() == {other[1]},
                           what="prefetch of new list")

    def test_manual_restart_marks_previous_not_natural(self):
        self.fp.set_playlist(self.paths, autoplay=True)
        self.wait_loaded(self.paths[0])
        self.fp.pop_start_events()
        self.fp.restart_track()            # user pressed P / export restart
        events = self.fp.pop_start_events()
        self.assertEqual(len(events), 1)
        self.assertFalse(events[0]["previous_natural_end"])

    def test_natural_end_marks_previous_natural(self):
        paths = [helpers.write_silent_wav(
            os.path.join(self.tmp, f"n{i}.wav"), 0.25) for i in range(2)]
        self.fp.set_playlist(paths, autoplay=True)
        self.wait_loaded(paths[0])
        self.fp.pop_start_events()
        helpers.drain_serial(self.fp, seconds=1.0)
        events = self.fp.pop_start_events()
        self.assertTrue(events, "second track never started")
        self.assertTrue(events[0]["previous_natural_end"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
