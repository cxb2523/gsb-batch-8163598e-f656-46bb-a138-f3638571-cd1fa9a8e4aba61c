"""Playlist duration probing: results are bound to entries, not paths.

The prober is replaced with a controllable fake so the tests never need ffprobe and can decide
exactly when (and for which entry) a result arrives.
"""

import os
import threading
import time

import pytest

pytest.importorskip("PySide6")

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from samovar_lite.playlist import DURATION_ROLE, PATH_ROLE, TOKEN_ROLE, PlaylistPanel  # noqa: E402


@pytest.fixture(scope="session")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture
def panel(qapp):
    made = []

    def factory(probe=None):
        p = PlaylistPanel(probe=probe)
        made.append(p)
        return p

    yield factory
    for p in made:
        p.shutdown(timeout=2.0)


def tokens(p):
    return [p.view.item(i).data(TOKEN_ROLE) for i in range(p.count())]


def durations(p):
    return [p.view.item(i).data(DURATION_ROLE) for i in range(p.count())]


def emit(p, token, duration):
    """Deliver a probe result directly (same-thread signal -> synchronous slot)."""
    p._durationReady.emit(token, duration)


def test_duplicate_paths_get_independent_durations(panel):
    p = panel(probe=lambda path: None)
    p.set_items(["/a/dup.mp4", "/a/dup.mp4", "/a/other.mp4"])
    first, second, third = tokens(p)
    assert [p.view.item(i).data(PATH_ROLE) for i in range(p.count())] == [
        "/a/dup.mp4",
        "/a/dup.mp4",
        "/a/other.mp4",
    ]

    emit(p, first, 12.0)
    emit(p, second, 34.0)
    assert durations(p) == [12.0, 34.0, None]  # each entry keeps its own result

    emit(p, first, 99.0)  # a second, later result never overwrites the first
    assert durations(p) == [12.0, 34.0, None]

    emit(p, third, 5.0)
    assert durations(p) == [12.0, 34.0, 5.0]
    total = sum(d or 0 for d in durations(p))
    assert total == 51.0  # header total stays truthful


def test_result_for_removed_entry_is_discarded(panel):
    p = panel(probe=lambda path: None)
    p.set_items(["/a/one.mp4", "/a/two.mp4"])
    one, two = tokens(p)

    p.view.item(0).setSelected(True)
    p.remove_selected()
    assert p.count() == 1

    emit(p, one, 11.0)  # late result from the deleted entry
    assert durations(p) == [None]

    emit(p, two, 22.0)  # the surviving entry still accepts its own result
    assert durations(p) == [22.0]


def test_results_after_set_items_rebuild_are_discarded(panel):
    p = panel(probe=lambda path: None)
    p.set_items(["/a/one.mp4", "/a/two.mp4"])
    old = tokens(p)

    p.set_items(["/a/one.mp4", "/a/two.mp4"])  # same paths, brand-new entries
    new = tokens(p)
    assert new != old

    emit(p, old[0], 1.0)
    emit(p, old[1], 2.0)
    assert durations(p) == [None, None]

    emit(p, new[0], 3.0)
    assert durations(p) == [3.0, None]


def test_results_after_clear_are_discarded(panel):
    p = panel(probe=lambda path: None)
    p.set_items(["/a/one.mp4"])
    token = tokens(p)[0]
    p.clear()
    emit(p, token, 9.0)
    assert p.count() == 0


def test_sort_keeps_the_binding_to_the_original_entry(panel):
    p = panel(probe=lambda path: None)
    p.set_items(["/a/zeta.mp4", "/a/alpha.mp4"])
    zeta_token, alpha_token = tokens(p)

    p.sort_by("name")  # alpha.mp4 now comes first
    assert [p.view.item(i).data(PATH_ROLE) for i in range(p.count())] == ["/a/alpha.mp4", "/a/zeta.mp4"]

    emit(p, zeta_token, 20.0)
    emit(p, alpha_token, 10.0)
    assert durations(p) == [10.0, 20.0]

    p.sort_by("reverse")
    assert [p.view.item(i).data(PATH_ROLE) for i in range(p.count())] == ["/a/zeta.mp4", "/a/alpha.mp4"]
    assert durations(p) == [20.0, 10.0]


def test_sort_by_duration_still_accepts_late_results(panel):
    p = panel(probe=lambda path: None)
    p.set_items(["/a/one.mp4", "/a/two.mp4"])
    one, two = tokens(p)
    emit(p, two, 5.0)

    p.sort_by("duration")  # one has no duration yet, so it sorts first (0 < 5)
    assert [p.view.item(i).data(PATH_ROLE) for i in range(p.count())] == ["/a/one.mp4", "/a/two.mp4"]
    emit(p, one, 30.0)  # arrives after the sort; must attach to the one entry, not row 0 by path
    assert [p.view.item(i).data(PATH_ROLE) for i in range(p.count())] == ["/a/one.mp4", "/a/two.mp4"]
    assert durations(p) == [30.0, 5.0]

    p.sort_by("duration")  # now one (30) is behind two (5)
    assert [p.view.item(i).data(PATH_ROLE) for i in range(p.count())] == ["/a/two.mp4", "/a/one.mp4"]
    assert durations(p) == [5.0, 30.0]


def test_remove_missing_discards_its_result_but_keeps_others(panel, tmp_path):
    present = tmp_path / "present.mp4"
    present.write_bytes(b"")
    missing = str(tmp_path / "missing.mp4")

    p = panel(probe=lambda path: None)
    p.set_items([missing, str(present)])
    missing_token, present_token = tokens(p)

    p._remove_missing()
    assert p.count() == 1
    emit(p, missing_token, 7.0)  # stale
    assert durations(p) == [None]
    emit(p, present_token, 8.0)
    assert durations(p) == [8.0]


def test_remove_duplicates_discards_only_the_dropped_entry(panel):
    p = panel(probe=lambda path: None)
    p.set_items(["/a/dup.mp4", "/a/dup.mp4"])
    kept, dropped = tokens(p)  # _remove_duplicates keeps the first occurrence

    p._remove_duplicates()
    assert p.count() == 1
    emit(p, dropped, 3.0)  # stale
    assert durations(p) == [None]
    emit(p, kept, 4.0)
    assert durations(p) == [4.0]


def test_added_duplicate_after_existing_entry_is_probed_separately(panel):
    p = panel(probe=lambda path: None)
    p.set_items(["/a/dup.mp4"])
    first = tokens(p)[0]
    emit(p, first, 10.0)

    p.add(["/a/dup.mp4", "/a/new.mp4"])
    tokens_now = tokens(p)
    assert len(tokens_now) == 3 and len(set(tokens_now)) == 3

    emit(p, tokens_now[1], 20.0)
    assert durations(p) == [10.0, 20.0, None]


def test_items_recreated_by_qt_drag_move_keep_their_binding(panel):
    p = panel(probe=lambda path: None)
    p.set_items(["/a/one.mp4", "/a/two.mp4"])
    one, two = tokens(p)
    p.set_current(0)
    # Qt's internal move serializes the item data and rebuilds the items from it. Drive it for
    # real: the model mime round-trip, then the view-level reindex the drop handler performs.
    model = p.view.model()
    mime = model.mimeData([model.index(0, 0)])
    current_token = p._token_of_current()
    p.view.takeItem(0)  # internal move takes the source entry out ...
    assert model.dropMimeData(mime, Qt.MoveAction, 1, 0, p.view.rootIndex())
    p._adopt_rebuilt_view(current_token)  # ... and the drop handler rebuilds the token map

    assert [p.view.item(i).data(PATH_ROLE) for i in range(p.count())] == ["/a/two.mp4", "/a/one.mp4"]
    assert p.current_row() == 1  # the moved entry is still "current"
    emit(p, one, 10.0)
    emit(p, two, 20.0)
    assert durations(p) == [20.0, 10.0]


def test_worker_thread_delivers_each_entry_its_own_result(panel, qapp):
    values = iter([12.0, 34.0])

    def probe(path):
        return next(values, None)  # a probe must have been called for the second entry

    p = panel(probe=probe)
    p.set_items(["/a/dup.mp4", "/a/dup.mp4"])

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and not all(durations(p)):
        qapp.processEvents()
        time.sleep(0.01)
    assert durations(p) == [12.0, 34.0]  # same path, two entries, two independent results


def test_shutdown_kills_an_inflight_ffprobe(monkeypatch):
    class FakeProc:
        """Stands in for ffprobe: communicate() blocks until stop() kills it."""

        def __init__(self):
            self.out = ""
            self.killing = threading.Event()

        def communicate(self, timeout=None):
            self.killing.wait(5.0)
            return self.out, ""

        def kill(self):
            self.killing.set()

    procs = []

    def fake_popen(*args, **kwargs):
        proc = FakeProc()
        procs.append(proc)
        return proc

    monkeypatch.setattr("samovar_lite.playlist.subprocess.Popen", fake_popen)
    monkeypatch.setattr("samovar_lite.playlist.shutil.which", lambda name: "ffprobe" if name == "ffprobe" else None)
    p = PlaylistPanel()  # no probe injected: exercises the real ffprobe path
    p.set_items(["/a/one.mp4", "/a/two.mp4"])
    token = tokens(p)[0]

    deadline = time.monotonic() + 2.0
    while not procs and time.monotonic() < deadline:
        time.sleep(0.01)
    assert procs, "ffprobe should have been started"

    started = time.monotonic()
    p.shutdown(timeout=2.0)
    assert time.monotonic() - started < 2.0
    assert p._prober.is_alive() is False
    assert procs[0].killing.is_set()

    emit(p, token, 1.0)  # a queued/late result must no longer reach the entry
    assert durations(p) == [None, None]


def test_shutdown_is_bounded_even_if_the_probe_ignores_the_stop():
    gate = threading.Event()
    entered = threading.Event()

    def slow_probe(path):
        entered.set()
        gate.wait(5.0)  # deliberately ignores the shutdown signal
        return 3.0

    p = PlaylistPanel(probe=slow_probe)
    p.set_items(["/a/one.mp4"])
    assert entered.wait(2.0)

    started = time.monotonic()
    p.shutdown(timeout=0.2)
    assert time.monotonic() - started < 1.0  # bounded wait, not "until the probe finishes"

    gate.set()
    p._prober.join(2.0)
    assert p._prober.is_alive() is False
    assert durations(p) == [None]  # the result was dropped, the row never got a bogus duration
