"""Record and replay the slide feed's ``FeedSnapshot`` stream (issue #70, Proclaim slice).

A live ``SlideFeed`` (e.g. ``ProclaimFeed``) emits one ``FeedSnapshot`` per poll. Recording
that stream **at the feed boundary** — never the Yjs doc — captures exactly the *stimulus* the
consumers react to, so it can later be replayed to drive the **real** consumers with no
Proclaim (or even no network) in the loop. This is the "simulated proclaim" mode of the replay
harness, and the basis for a consumer regression test.

Three roles share one dead-simple on-disk format (JSONL, one record per line):

- ``RecordingSlideFeed`` wraps a live feed and appends each polled snapshot; drop it in via
  ``proclaim_service.py --record PATH`` during a live service. It changes nothing the consumers
  see — the same snapshot is returned unmodified.
- ``ReplaySlideFeed`` re-emits a recorded stream *as* a ``SlideFeed``, honoring the recorded
  inter-snapshot timing (scaled), so the existing ``SlideSyncRuntime`` can replay a fixture
  against a real Y-Sweet unchanged (``proclaim_service.py --replay PATH``).
- ``replay_records_through_consumers`` plays a recording straight through a real
  ``YjsSlidePublisher`` + ``SlideTranslator`` on a local Doc and returns it — the offline,
  network-free path used by the replay regression test.

Record line schema (one JSON object per line)::

    {"ts": <float epoch seconds>, "snapshot": {<FeedSnapshot.to_json()>}}

``ts`` is the wall-clock time the snapshot was produced. Only inter-record *deltas* matter on
replay (absolute times are normalized to the first record), matching issue #70's "timestamps
recorded absolute, normalized to service-relative on replay."

Like ``slide_feed``, this module is dependency-light and has **no import-time side effects**,
so it imports cleanly in tests without a configured environment.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    List,
    Optional,
    Union,
)

import anyio

from slide_feed import FeedSnapshot, SessionInfo, SlideFeed, SnapshotBus

logger = logging.getLogger(__name__)

PathLike = Union[str, Path]


@dataclass(frozen=True)
class SnapshotRecord:
    """One recorded line: a snapshot plus the wall-clock time it was produced."""

    ts: float
    snapshot: FeedSnapshot

    def to_json_line(self) -> str:
        return json.dumps({'ts': self.ts, 'snapshot': self.snapshot.to_json()})

    @classmethod
    def from_json_obj(cls, obj: Dict[str, Any]) -> 'SnapshotRecord':
        return cls(ts=float(obj['ts']), snapshot=FeedSnapshot.from_json(obj['snapshot']))


def load_records(path: PathLike) -> List[SnapshotRecord]:
    """Load a recorded snapshot stream (JSONL). Blank lines are skipped."""
    records: List[SnapshotRecord] = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(SnapshotRecord.from_json_obj(json.loads(line)))
    return records


def write_records(path: PathLike, records: List[SnapshotRecord]) -> None:
    """Write a snapshot stream to a JSONL file (used to author/regenerate fixtures)."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, 'w', encoding='utf-8') as f:
        for record in records:
            f.write(record.to_json_line() + '\n')


class RecordingSlideFeed:
    """A ``SlideFeed`` that transparently records every snapshot the wrapped feed produces.

    Delegates ``poll``/``reset`` to the inner feed and appends the polled snapshot to a JSONL
    file as a side effect. The file is opened lazily on first poll, in append mode, and flushed
    per line, so a recording survives a crash and can be tailed live. A write failure is logged
    and swallowed — recording must never take the live service down.
    """

    def __init__(
        self,
        feed: SlideFeed,
        path: PathLike,
        *,
        clock: Callable[[], float] = time.time,
    ):
        self._feed = feed
        self._path = Path(path)
        self._clock = clock
        self._file: Optional[Any] = None

    def _ensure_open(self) -> Any:
        if self._file is None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._file = open(self._path, 'a', encoding='utf-8')
            logger.info(f"Recording slide feed snapshots to {self._path}")
        return self._file

    async def poll(self) -> FeedSnapshot:
        snap = await self._feed.poll()
        try:
            f = self._ensure_open()
            f.write(SnapshotRecord(self._clock(), snap).to_json_line() + '\n')
            f.flush()
        except OSError as e:
            logger.warning(f"Failed to record snapshot (continuing live): {e}")
        return snap

    def reset(self) -> None:
        self._feed.reset()

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None


def _off_air_after(records: List[SnapshotRecord]) -> FeedSnapshot:
    """The off-air snapshot returned once a replay is exhausted (carries the last session)."""
    session: Optional[SessionInfo] = records[-1].snapshot.session if records else None
    return FeedSnapshot(on_air=False, session=session)


class ReplaySlideFeed:
    """Re-emit a recorded snapshot stream as a ``SlideFeed`` for ``SlideSyncRuntime``.

    Honors the recorded inter-snapshot timing (scaled by ``time_scale``) so a replay against a
    real Y-Sweet reproduces the original slide-change cadence; ``time_scale=0`` replays as fast
    as possible (used by tests). When the stream is exhausted it reports off air — the natural
    "service ended" — which makes the runtime disconnect, and it keeps returning off air
    thereafter. ``reset`` is a no-op: a replay is a fixed stream, not a live source with caches.

    ``clock``/``sleep`` are injectable so timing can be driven deterministically in tests.
    """

    def __init__(
        self,
        records: List[SnapshotRecord],
        *,
        time_scale: float = 1.0,
        clock: Callable[[], float] = anyio.current_time,
        sleep: Callable[[float], Awaitable[None]] = anyio.sleep,
    ):
        self._records = list(records)
        self._time_scale = time_scale
        self._clock = clock
        self._sleep = sleep
        self._index = 0
        self._start_wall = self._records[0].ts if self._records else 0.0
        self._start_mono: Optional[float] = None

    async def poll(self) -> FeedSnapshot:
        if self._index >= len(self._records):
            return _off_air_after(self._records)

        record = self._records[self._index]
        if self._start_mono is None:
            self._start_mono = self._clock()

        # Sleep until this record's scheduled offset from the first record (scaled).
        target_offset = (record.ts - self._start_wall) * self._time_scale
        elapsed = self._clock() - self._start_mono
        delay = target_offset - elapsed
        if delay > 0:
            await self._sleep(delay)

        self._index += 1
        return record.snapshot

    def reset(self) -> None:
        pass


def _expected_translation_keys(
    records: List[SnapshotRecord], languages: List[str]
) -> List[str]:
    """Every (language, non-empty slide) key the translator should eventually cover."""
    from proclaim_lib import slide_translation_key

    keys: List[str] = []
    seen = set()
    for record in records:
        for item in record.snapshot.items.values():
            for slide in item.slides:
                if not slide.strip():
                    continue
                for language in languages:
                    key = slide_translation_key(language, slide)
                    if key not in seen:
                        seen.add(key)
                        keys.append(key)
    return keys


async def replay_records_through_consumers(
    records: List[SnapshotRecord],
    languages: List[str],
    translate_fn: Callable[..., Awaitable[Optional[Dict[str, Any]]]],
    *,
    doc: Optional[Any] = None,
    time_scale: float = 0.0,
    scan_interval: float = 0.001,
    settle_timeout: float = 5.0,
) -> Any:
    """Replay a recording through the REAL consumers on one Doc; return the Doc.

    Mirrors the runtime's per-cycle fan-out — ``publisher.apply`` inline plus ``bus.publish``
    to wake the translator, and (like the runtime) applies **only on-air snapshots** — without
    any Y-Sweet or Proclaim. Waits until the translator has covered every slide seen in the
    recording (or ``settle_timeout`` elapses) before returning, so callers can assert a settled
    end-state. Network-free; this is the offline half of the "simulated proclaim" mode and the
    engine of the replay regression test.
    """
    from pycrdt import Doc

    from slide_translator import SlideTranslator
    from yjs_publisher import YjsSlidePublisher

    doc = doc if doc is not None else Doc()
    publisher = YjsSlidePublisher()
    publisher.bind(doc)
    translator = SlideTranslator(translate_fn, languages, scan_interval=scan_interval)
    translator.bind(doc)
    feed = ReplaySlideFeed(records, time_scale=time_scale)
    bus = SnapshotBus()

    expected = _expected_translation_keys(records, languages)

    async with anyio.create_task_group() as tg:
        tg.start_soon(translator.run, bus)

        for _ in range(len(records)):
            snap = await feed.poll()
            if not snap.on_air:
                continue  # off-air (lead-in / end) drives no consumer writes, as in the runtime
            publisher.apply(snap)
            bus.publish(snap)

        if expected:
            with anyio.move_on_after(settle_timeout):
                while not all(k in translator.translations_map for k in expected):
                    await anyio.sleep(scan_interval)

        tg.cancel_scope.cancel()

    return doc
