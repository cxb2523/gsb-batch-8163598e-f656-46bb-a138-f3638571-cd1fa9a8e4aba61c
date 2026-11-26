"""The engine's state machine against the fake mpv (no audio, no network).

Durations are encoded in the file names (``fake-dur-<s>``, see
tests/fakes/fake_mpv.py), so a test picks how long each "track" plays.

The player-lifecycle tests below also look at the processes the fake mpv
leaves behind: ``FAKE_MPV_LOG`` gets one JSON line per launch with its pid,
which they use to check that a fast next/jump/stop never leaves two mpvs alive
or a temp IPC/log directory behind.
"""

import glob
import json
import os
import tempfile
import threading
import time

import pytest

from conftest import needs_fake_mpv, pid_alive
from tunetape import config, history, sources
from tunetape.engine import Engine, EngineError

pytestmark = needs_fake_mpv


def latest_history(url):
    """The newest history entry, once it is ``url``'s. The engine records it
    just after the state turns "playing", so seeing that isn't enough."""
    def check():
        entries = history.load()
        return entries[0] if entries and entries[0]["url"] == url else None
    return wait_for(check)


def wait_for(predicate, timeout=10.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError("condition not met in time")


@pytest.fixture
def engine(data_dir):
    events = []
    eng = Engine(lambda t, d: events.append((t, d)))
    eng.events = events
    yield eng
    eng.shutdown()


def launches(log_path):
    """Every fake-mpv launch the log knows about: ``[{"argv", "pid"}]``."""
    try:
        text = log_path.read_text()
    except OSError:
        return []
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def live_launches(log_path):
    """Launches whose fake mpv is still running."""
    return [entry for entry in launches(log_path) if pid_alive(entry["pid"])]


def tunetape_temp_dirs():
    """The private temp dirs MPVController makes (IPC sockets, mpv logs)."""
    return set(glob.glob(os.path.join(tempfile.gettempdir(), "tunetape_*")))


def wait_until_no_launch(log_path, previous, timeout=10.0):
    """Wait for every launch recorded before ``previous`` to have exited."""
    wait_for(lambda: not [e for e in live_launches(log_path)
                          if e["pid"] in {l["pid"] for l in previous}],
             timeout=timeout)


def state(eng):
    return eng.status()["state"]


def statuses(eng):
    return [it["status"] for it in eng.queue_list()["items"]]


def test_plays_and_auto_advances(engine, audio):
    a = audio("a-fake-dur-0.4.mp3")
    b = audio("b-fake-dur-0.4.mp3")
    engine.add(a)
    engine.add(b)
    wait_for(lambda: state(engine) == "playing")
    assert engine.status()["index"] == 0
    wait_for(lambda: engine.status()["index"] == 1 and state(engine) == "playing")
    # After the last item the player goes idle and keeps the queue.
    wait_for(lambda: state(engine) == "idle")
    assert statuses(engine) == ["played", "played"]
    s = engine.status()
    assert s["length"] == 2 and s["index"] == 1 and not s["has_next"]


def test_fail_forward_skips_a_bad_item(engine, audio):
    engine.add(audio("fake-fail-1.mp3"))
    engine.add(audio("good-fake-dur-5.mp3"))
    wait_for(lambda: state(engine) == "playing")
    assert statuses(engine) == ["failed", "playing"]
    errors = [d for t, d in engine.events if t == "error"]
    assert errors and errors[0]["item_id"] == engine.queue_list()["items"][0]["id"]


def test_fail_forward_stops_after_five_in_a_row(engine, audio):
    for n in range(7):
        engine.add(audio(f"fake-fail-{n}.mp3"))
    wait_for(lambda: state(engine) == "idle" and statuses(engine).count("failed") == 5)
    time.sleep(0.3)
    assert statuses(engine) == ["failed"] * 5 + ["queued"] * 2
    assert "5 tracks in a row" in engine.status()["message"]


def test_failure_on_the_last_item_stops(engine, audio):
    engine.add(audio("fake-fail-last.mp3"))
    wait_for(lambda: statuses(engine) == ["failed"])
    wait_for(lambda: state(engine) == "idle")


def test_next_prev_jump(engine, audio):
    for name in ("a", "b", "c"):
        engine.add(audio(f"{name}-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    with pytest.raises(EngineError) as e:
        engine.prev()
    assert e.value.code == 1013

    engine.next()
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 1)
    engine.jump(2)
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 2)
    with pytest.raises(EngineError) as e:
        engine.next()
    assert e.value.code == 1013
    engine.prev()
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 1)
    assert statuses(engine) == ["played", "playing", "played"]
    for bad in (-1, 3):
        with pytest.raises(EngineError) as e:
            engine.jump(bad)
        assert e.value.code == 1013
    with pytest.raises(EngineError) as e:
        engine.jump("1")
    assert e.value.code == -32602


def test_a_wedged_mpv_does_not_hold_up_the_next_item(engine, audio, monkeypatch):
    # The old mpv ignores SIGTERM and lingers 3s after quit; skipping (here
    # while paused) must still start the next item at once.
    monkeypatch.setenv("FAKE_MPV_SLOW_QUIT", "3")
    engine.add(audio("a-fake-dur-30.mp3"))
    engine.add(audio("b-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    engine.pause()
    start = time.monotonic()
    engine.jump(1)
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 1)
    assert time.monotonic() - start < 1.5


def test_at_now_and_next(engine, audio):
    engine.add(audio("first-fake-dur-30.mp3"))
    engine.add(audio("last-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    engine.add(audio("inserted-fake-dur-30.mp3"), at="next")
    titles = [it["title"] for it in engine.queue_list()["items"]]
    assert titles == ["first-fake-dur-30", "inserted-fake-dur-30", "last-fake-dur-30"]

    engine.add(audio("now-fake-dur-30.mp3"), at="now")
    wait_for(lambda: state(engine) == "playing")
    q = engine.queue_list()
    assert [it["title"] for it in q["items"]] == ["now-fake-dur-30"] and q["index"] == 0


def test_idle_queue_starts_with_the_new_request(engine, audio):
    engine.add(audio("one-fake-dur-0.3.mp3"))
    wait_for(lambda: statuses(engine) == ["played"] and state(engine) == "idle")
    engine.add(audio("two-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 1)


def test_title_param_and_search_history(engine):
    engine.add("ytsearch1:daft punk around the world", title="Daft Punk — Around the World")
    wait_for(lambda: state(engine) == "playing")
    s = engine.status()
    assert s["current"]["title"] == "Daft Punk — Around the World"
    entry = latest_history("ytsearch1:daft punk around the world")
    assert entry["type"] == "ai"
    assert entry["url"] == "ytsearch1:daft punk around the world"
    assert entry["title"] == "Daft Punk — Around the World"


def test_words_become_a_search_titled_by_yt_dlp(engine):
    result = engine.add("daft punk")
    assert result["request"]["kind"] == "search"
    wait_for(lambda: state(engine) == "playing")
    assert engine.status()["current"]["title"] == "Fake: daft punk"
    assert engine.request_get(result["request"]["id"])["request"]["title"] == "Fake: daft punk"


def test_history_for_files_and_collections(engine, audio, monkeypatch):
    monkeypatch.setenv("FAKE_MPV_DURATION", "0.3")
    path = audio("Song-fake-dur-30.mp3")
    engine.add(path)
    wait_for(lambda: state(engine) == "playing")
    assert latest_history(path)["type"] == "file"

    url = "https://www.youtube.com/playlist?list=PLfake"
    engine.add(url, at="now", start_index=1, wait=True)
    wait_for(lambda: state(engine) == "playing")
    entry = latest_history(url)
    assert entry["type"] == "youtube_playlist"
    assert entry["track_count"] == 3 and entry["last_index"] == 1
    assert engine.status()["current"]["collection"] == {
        "title": "YouTube Playlist", "index": 1, "count": 3}
    # last_index follows the current item, without bumping play_count.
    wait_for(lambda: engine.status()["index"] == 2 and state(engine) == "playing")
    wait_for(lambda: history.load()[0]["last_index"] == 2)
    assert history.load()[0]["play_count"] == 1


def test_wait_reports_a_failed_expansion(engine):
    with pytest.raises(EngineError) as e:
        engine.add("https://www.youtube.com/playlist?list=fake-unavailable", wait=True)
    assert e.value.code == 1014
    assert e.value.data["request"]["status"] == "failed"
    assert e.value.data["request"]["error"]


def test_classification_errors_are_synchronous(engine):
    with pytest.raises(EngineError) as e:
        engine.add("lavfi:sine")
    assert e.value.code == 1010
    with pytest.raises(EngineError) as e:
        engine.add("x", at="later")
    assert e.value.code == -32602


def test_volume_is_persisted_and_carried(engine, audio, data_dir, monkeypatch, tmp_path):
    log = tmp_path / "mpv-argv.jsonl"
    monkeypatch.setenv("FAKE_MPV_LOG", str(log))
    config.set_setting("normalize_volume", False)
    engine.add(audio("a-fake-dur-30.mp3"))
    engine.add(audio("b-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    s = engine.set_volume(value=55)
    assert s["volume"] == 55
    assert config.get_volume() == 55
    assert engine.set_volume(delta=200)["volume"] == 130  # clamped
    engine.set_volume(delta=-75)
    with pytest.raises(EngineError):
        engine.set_volume()
    engine.next()
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 1)
    launches = [json.loads(line)["argv"] for line in log.read_text().splitlines()]
    assert "--volume=55" in launches[-1]
    # normalize_volume is off, so no launch asked for dynaudnorm.
    assert not any("dynaudnorm" in a for argv in launches for a in argv)


def test_normalize_setting_is_read_per_item(engine, audio, monkeypatch, tmp_path):
    log = tmp_path / "mpv-argv.jsonl"
    monkeypatch.setenv("FAKE_MPV_LOG", str(log))
    config.set_setting("normalize_volume", True)
    engine.add(audio("n-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    argv = json.loads(log.read_text().splitlines()[-1])["argv"]
    assert any(a.startswith("--af=") and "dynaudnorm" in a for a in argv)


def test_pause_resume_mute_seek(engine, audio):
    for method in (engine.pause, engine.resume, engine.toggle, engine.mute):
        with pytest.raises(EngineError) as e:
            method()
        assert e.value.code == 1012
    engine.add(audio("x-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    assert engine.pause()["state"] == "paused"
    assert engine.toggle()["state"] == "playing"
    assert engine.mute()["muted"] is True
    assert engine.mute(False)["muted"] is False
    s = engine.seek(10, relative=False)
    assert 10 <= s["position"] < 12
    assert engine.status()["duration"] == 30


def test_levels_and_stats(engine, audio):
    s = engine.status(levels=True, stats=True)
    assert s["levels"] is None and s["stats"] is None
    engine.add(audio("x-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    s = wait_for(lambda: (lambda st: st if st["levels"] else None)(
        engine.status(levels=True, stats=True)))
    # The fake reports channel 2 as "-inf": silence is clamped to -200 dBFS.
    assert s["levels"] == [[-20.5, -6.0], [-200.0, -200.0]]
    assert s["stats"]["codec"] == "mp3" and s["stats"]["samplerate"] == 44100
    json.dumps(s, allow_nan=False)


def test_status_never_waits_on_a_resolver(engine, monkeypatch):
    release = threading.Event()
    real_resolve = sources.resolve

    def slow_resolve(track, kind):
        release.wait(10)
        return real_resolve(track, kind)

    monkeypatch.setattr(sources, "resolve", slow_resolve)
    engine.add("ytsearch1:slow one")
    start = time.monotonic()
    for _ in range(10):
        s = engine.status(levels=True, stats=True)
    assert time.monotonic() - start < 0.5
    assert s["state"] == "loading" and s["message"].startswith("Loading")
    release.set()
    wait_for(lambda: state(engine) == "playing")


def test_remove_and_clear(engine, audio):
    for name in ("a", "b", "c"):
        engine.add(audio(f"{name}-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    items = engine.queue_list()["items"]
    with pytest.raises(EngineError) as e:
        engine.remove("i-nope")
    assert e.value.code == 1013
    # Removing the current item skips to the next one.
    q = engine.remove(items[0]["id"])
    assert [it["id"] for it in q["items"]] == [items[1]["id"], items[2]["id"]]
    wait_for(lambda: state(engine) == "playing")
    assert engine.status()["current"]["id"] == items[1]["id"]
    assert engine.clear() == {"items": [], "index": -1}
    s = engine.status()
    assert s["state"] == "idle" and s["current"] is None and s["index"] == -1


def test_stop_keeps_the_queue(engine, audio):
    engine.add(audio("a-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    s = engine.stop()
    assert s["state"] == "idle" and s["length"] == 1
    assert engine.is_idle()


def test_events(engine, audio):
    engine.add(audio("a-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    wait_for(lambda: any(t == "state" and d["state"] == "playing" for t, d in engine.events))
    types = {t for t, _ in engine.events}
    assert {"request", "queue", "state", "track"} <= types
    request_states = [d["request"]["status"] for t, d in engine.events if t == "request"]
    assert request_states[0] == "pending" and request_states[-1] == "done"


def test_requests_list(engine, audio):
    first = engine.add(audio("a-fake-dur-30.mp3"))["request"]
    second = engine.add(audio("b-fake-dur-30.mp3"))["request"]
    listed = engine.requests_list()["requests"]
    assert [r["id"] for r in listed] == [second["id"], first["id"]]
    with pytest.raises(EngineError) as e:
        engine.request_get("r-nope")
    assert e.value.code == 1013


def test_discover_needs_configuration(engine):
    with pytest.raises(EngineError) as e:
        engine.discover("rainy jazz")
    assert e.value.code == 1020


def test_discover_records_the_request(engine, monkeypatch):
    from tunetape import ai
    from tunetape.models import Track
    monkeypatch.setattr(ai, "is_configured", lambda: True)
    monkeypatch.setattr(ai, "suggest_tracks", lambda r: [
        Track(name="Miles Davis — So What", resolve_hint="ytsearch1:Miles Davis So What")])
    result = engine.discover("rainy jazz")
    assert result == {"tracks": [{"title": "Miles Davis — So What",
                                  "input": "ytsearch1:Miles Davis So What"}]}
    assert history.load()[0]["type"] == "ai_search"

    def boom(r):
        raise ConnectionError("Network error reaching the AI.")
    monkeypatch.setattr(ai, "suggest_tracks", boom)
    with pytest.raises(EngineError) as e:
        engine.discover("rainy jazz")
    assert e.value.code == 1021


# -- volume and mute are session state, not per-track ----------------------------


def test_mute_survives_a_track_change(engine, audio):
    for name in ("a", "b", "c"):
        engine.add(audio(f"{name}-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    assert engine.mute(True)["muted"] is True

    engine.next()  # jump the queue: a new mpv
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 1)
    assert engine.status()["muted"] is True

    engine.jump(2)
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 2)
    assert engine.status()["muted"] is True


def test_mute_holds_when_playback_stops_and_restarts(engine, audio):
    # From idle (stop) and from idle (the queue ran out) the next mpv starts
    # muted too: mute is session state, not a per-mpv setting.
    engine.add(audio("a-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    engine.mute(True)
    engine.stop()
    assert engine.status()["muted"] is True
    engine.add(audio("b-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    assert engine.status()["muted"] is True


def test_volume_survives_a_track_change(engine, audio):
    for name in ("a", "b"):
        engine.add(audio(f"{name}-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    engine.set_volume(value=37)
    engine.next()
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 1)
    assert engine.status()["volume"] == 37


def test_mute_started_at_launch(engine, audio, monkeypatch, tmp_path):
    # Not just tracked in the engine's status: the player that takes over is
    # told to be muted from the start (the fake honors --mute=yes on its argv).
    log = tmp_path / "mpv-argv.jsonl"
    monkeypatch.setenv("FAKE_MPV_LOG", str(log))
    config.set_setting("normalize_volume", False)
    engine.add(audio("a-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    engine.mute(True)
    engine.add(audio("b-fake-dur-30.mp3"), at="now")
    wait_for(lambda: state(engine) == "playing" and engine.status()["length"] == 1)
    argv = launches(log)[-1]["argv"]
    assert "--mute=yes" in argv
    assert "--volume=100" in argv


def test_volume_change_during_a_launch_is_not_rolled_back(engine, audio, monkeypatch):
    """A volume change made while the next mpv is starting must win.

    The launch reads the session only after its generation is confirmed; the
    change lands on the player right after it registers, so the level the
    user set is the one both the status and the new mpv end up with.
    """
    for name in ("a", "b"):
        engine.add(audio(f"{name}-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")

    real_resolve = sources.resolve
    resolving = threading.Event()
    release = threading.Event()

    def slow_resolve(track, kind):
        if track.name.startswith("b-"):
            resolving.set()
            release.wait(10)
        return real_resolve(track, kind)

    monkeypatch.setattr(sources, "resolve", slow_resolve)
    engine.next()  # index 1's worker now blocks in resolve, launch not yet done
    assert resolving.wait(10)
    engine.set_volume(value=42)
    release.set()
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 1)
    assert engine.status()["volume"] == 42
    # mpv itself agrees, not just the engine's bookkeeping.
    assert engine._controller.get_volume() == 42


def test_volume_change_while_mpv_is_starting_is_not_rolled_back(audio, data_dir):
    """Same race, in the other window: the factory (mpv launch) is in flight.

    The engine serializes session changes with launches and reconciles the new
    player against the session once it registers, so a level set mid-launch is
    neither lost nor overwritten when the launch completes.
    """
    from tunetape.player import MPVController

    starting = threading.Event()
    release = threading.Event()

    def factory(stream_url, normalize=False, volume=None, muted=False):
        starting.set()
        release.wait(10)
        return MPVController(stream_url, normalize=normalize, volume=volume, muted=muted)

    events = []
    eng = Engine(lambda t, d: events.append((t, d)), controller_factory=factory)
    try:
        eng.add(audio("a-fake-dur-30.mp3"))
        assert starting.wait(10)
        eng.set_volume(value=42)
        eng.mute(True)
        release.set()
        wait_for(lambda: state(eng) == "playing")
        assert eng.status()["volume"] == 42
        assert eng.status()["muted"] is True
        assert eng._controller.get_volume() == 42
        assert eng._controller.is_muted() is True
    finally:
        release.set()
        eng.shutdown()


# -- the player lifecycle -------------------------------------------------------


def test_fast_next_leaves_exactly_one_player(engine, audio, monkeypatch, tmp_path):
    log = tmp_path / "mpv-argv.jsonl"
    monkeypatch.setenv("FAKE_MPV_LOG", str(log))
    for name in ("a", "b", "c", "d"):
        engine.add(audio(f"{name}-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    before = launches(log)

    # Fast successive skips, ending on a known item.
    for index in (1, 2, 3, 0, 1, 2):
        engine.jump(index)
        time.sleep(0.02)
    wait_for(lambda: state(engine) == "playing" and engine.status()["index"] == 2)
    wait_until_no_launch(log, before)
    # Every earlier player is gone; one mpv (for the current item) is alive.
    assert len(live_launches(log)) == 1
    assert engine.status()["state"] == "playing"


def test_fast_jump_and_stop_leave_nothing_behind(engine, audio, monkeypatch, tmp_path):
    log = tmp_path / "mpv-argv.jsonl"
    monkeypatch.setenv("FAKE_MPV_LOG", str(log))
    before_dirs = tunetape_temp_dirs()
    for name in ("a", "b", "c"):
        engine.add(audio(f"{name}-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")

    engine.jump(1)
    engine.jump(2)
    engine.jump(0)
    assert engine.stop()["state"] == "idle"
    # stop() returns only once every player is fully torn down.
    assert live_launches(log) == []
    # …and their private temp dirs (IPC sockets, mpv logs) are removed with it.
    assert tunetape_temp_dirs() - before_dirs == set()


def test_stop_leaves_no_temp_dirs_and_play_again_works(engine, audio, monkeypatch, tmp_path):
    log = tmp_path / "mpv-argv.jsonl"
    monkeypatch.setenv("FAKE_MPV_LOG", str(log))
    before_dirs = tunetape_temp_dirs()
    engine.add(audio("a-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    engine.set_volume(value=55)
    engine.mute(True)

    assert engine.stop()["state"] == "idle"
    assert live_launches(log) == []
    assert tunetape_temp_dirs() - before_dirs == set()

    # Same queue, started again from the front: a clean launch that still has
    # the session's volume and mute.
    engine.add(audio("b-fake-dur-30.mp3"), at="now")
    wait_for(lambda: state(engine) == "playing")
    assert engine.status()["volume"] == 55
    assert engine.status()["muted"] is True
    engine.stop()
    assert tunetape_temp_dirs() - before_dirs == set()


def test_stop_waits_for_a_slow_player_to_exit(engine, audio, monkeypatch, tmp_path):
    """With a wedged mpv, stop() still waits for the complete teardown.

    The old design returned at once and tore the player down in the background,
    which is how a restart right afterwards could meet the previous mpv.
    """
    monkeypatch.setenv("FAKE_MPV_SLOW_QUIT", "2")
    log = tmp_path / "mpv-argv.jsonl"
    monkeypatch.setenv("FAKE_MPV_LOG", str(log))
    before_dirs = tunetape_temp_dirs()
    engine.add(audio("a-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")

    assert engine.stop()["state"] == "idle"
    # mpv ignored SIGTERM and lingered, but stop() waited for the kill.
    assert live_launches(log) == []
    assert tunetape_temp_dirs() - before_dirs == set()


def test_clear_leaves_nothing_behind(engine, audio, monkeypatch, tmp_path):
    log = tmp_path / "mpv-argv.jsonl"
    monkeypatch.setenv("FAKE_MPV_LOG", str(log))
    before_dirs = tunetape_temp_dirs()
    for name in ("a", "b"):
        engine.add(audio(f"{name}-fake-dur-30.mp3"))
    wait_for(lambda: state(engine) == "playing")
    assert engine.clear() == {"items": [], "index": -1}
    assert live_launches(log) == []
    assert tunetape_temp_dirs() - before_dirs == set()

