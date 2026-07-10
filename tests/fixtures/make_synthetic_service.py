#!/usr/bin/env python3
"""Generate the in-repo synthetic replay fixture (``synthetic_service.jsonl``).

A tiny hand-authored "test sermon" — three items, an off-air lead-in, the active pointer
advancing through slides, and an off-air end — recorded in the same JSONL format a live
``--record`` run produces. Committed so plumbing/replay tests (and coding agents) always have a
runnable, zero-network end-to-end; regenerate with ``uv run tests/fixtures/make_synthetic_service.py``
if the ``FeedSnapshot`` shape changes.

Timestamps are absolute wall-clock seconds; only their deltas matter on replay.
"""

from datetime import date
from pathlib import Path

from proclaim_lib import slides_hash
from slide_feed import FeedItem, FeedSnapshot, SessionInfo
from slide_replay import SnapshotRecord, write_records

SESSION = SessionInfo(presentation_id='pres-test', session_date=date(2026, 6, 28))

ITEMS = {
    'welcome': FeedItem(
        item_id='welcome',
        title='Welcome',
        slides=['Welcome to the service', 'Please stand'],
        item_kind='Content',
        slides_hash=slides_hash(['Welcome to the service', 'Please stand']),
        existing_translation=None,
    ),
    'song1': FeedItem(
        item_id='song1',
        title='Amazing Grace',
        slides=['Amazing grace, how sweet the sound', 'That saved a wretch like me'],
        item_kind='SongLyrics',
        slides_hash=slides_hash(
            ['Amazing grace, how sweet the sound', 'That saved a wretch like me']
        ),
        existing_translation=None,
    ),
    'sermon': FeedItem(
        item_id='sermon',
        title='Consider the Lilies',
        slides=['Consider the lilies of the field', 'They neither toil nor spin'],
        item_kind='Content',
        slides_hash=slides_hash(
            ['Consider the lilies of the field', 'They neither toil nor spin']
        ),
        existing_translation=None,
    ),
}

ORDER = ['welcome', 'song1', 'sermon']


def _on_air(seq: int, active_item: str, slide: int) -> FeedSnapshot:
    return FeedSnapshot(
        on_air=True,
        session=SESSION,
        order=list(ORDER),
        items=dict(ITEMS),
        active_item_id=active_item,
        active_slide_index=slide,
        seq=seq,
    )


def build_records() -> list[SnapshotRecord]:
    # (relative_time_seconds, snapshot)
    timeline = [
        (0.0, FeedSnapshot(on_air=False, session=None, seq=1)),           # lead-in, off air
        (5.0, _on_air(2, 'welcome', 0)),
        (12.0, _on_air(3, 'welcome', 1)),
        (20.0, _on_air(4, 'song1', 0)),
        (28.0, _on_air(5, 'song1', 1)),
        (40.0, _on_air(6, 'sermon', 0)),
        (900.0, _on_air(7, 'sermon', 1)),                                 # long sermon slide
        (1200.0, FeedSnapshot(                                            # service ends, off air
            on_air=False, session=SESSION, order=list(ORDER),
            items=dict(ITEMS), active_item_id=None, active_slide_index=None, seq=8,
        )),
    ]
    base = 1_735_000_000.0  # arbitrary absolute epoch; replay normalizes to the first record
    return [SnapshotRecord(base + rel, snap) for rel, snap in timeline]


if __name__ == '__main__':
    out = Path(__file__).parent / 'synthetic_service.jsonl'
    write_records(out, build_records())
    print(f"Wrote {out}")
