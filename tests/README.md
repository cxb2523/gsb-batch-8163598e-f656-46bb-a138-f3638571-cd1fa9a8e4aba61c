# Prefetch / export chapter tests

Regression tests for the playlist prefetch cache and the export chapter
timeline. They use pygame's dummy video/audio drivers and local silent WAV
files, so no window, sound card or ffmpeg setup is needed for the unit tests
(the end-to-end tests use `imageio_ffmpeg` when available).

```bash
python -I tests/test_prefetch_cache.py -v     # cache invalidation & start events
python -I tests/test_export_chapters.py -v    # chapter offsets + real mp4
python -I tests/test_export_integration.py -v # fast switching / append during export
```

Covered guarantees:

* the prefetch cache holds at most one entry and only for the track that is
  the *next* one of the current playlist index;
* a prefetch finishing after a track switch / append / playlist replace is
  discarded and never overwrites the active track's analysis;
* the cache entry is consumed by the next load and cleared;
* every track start is reported once, in play order, even for very short
  tracks that are switched quickly;
* mp4 chapters match the playlist order and start at the accumulated actual
  playing time.
