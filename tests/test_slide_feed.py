"""Tests for the slide-feed seam types and the SnapshotBus.

These import ``slide_feed`` with no environment configured, proving the module is
import-clean (no env reads / asserts at import time).
"""

from datetime import date

import anyio
import pytest

from slide_feed import FeedItem, FeedSnapshot, SessionInfo, SlideFeed, SnapshotBus

pytestmark = pytest.mark.anyio


def make_snapshot(**overrides) -> FeedSnapshot:
    base = dict(
        on_air=True,
        session=SessionInfo(presentation_id='pres-1', session_date=date(2030, 1, 15)),
        order=['i1', 'i2'],
        items={
            'i1': FeedItem('i1', 'Call to Worship', ['A', 'B'], 'Content', 'h1', 'Bonjou'),
            'i2': FeedItem('i2', 'Song', ['C'], 'SongLyrics', 'h2', None),
        },
        active_item_id='i1',
        active_slide_index=1,
        seq=7,
    )
    base.update(overrides)
    return FeedSnapshot(**base)


def test_snapshot_json_round_trips():
    """A snapshot survives to_json -> from_json unchanged (the #70 recording contract)."""
    snap = make_snapshot()
    restored = FeedSnapshot.from_json(snap.to_json())
    assert restored == snap


def test_snapshot_json_is_plain_serializable():
    """to_json yields only primitives (so json.dumps works without a custom encoder)."""
    import json

    snap = make_snapshot()
    text = json.dumps(snap.to_json())
    assert FeedSnapshot.from_json(json.loads(text)) == snap


def test_off_air_snapshot_round_trips():
    """An off-air snapshot (no session, empty order) also round-trips."""
    snap = FeedSnapshot(on_air=False, session=None)
    assert FeedSnapshot.from_json(snap.to_json()) == snap


def test_feed_item_defaults_existing_translation_none():
    item = FeedItem('i', 't', ['s'], 'Content', 'h')
    assert item.existing_translation is None
    assert FeedItem.from_json(item.to_json()) == item


def test_proclaim_feed_conforms_to_protocol_structurally():
    """A duck-typed object with poll/reset satisfies the runtime-checkable Protocol."""

    class Dummy:
        async def poll(self):  # pragma: no cover - not called
            return FeedSnapshot(on_air=False, session=None)

        def reset(self):  # pragma: no cover - not called
            pass

    assert isinstance(Dummy(), SlideFeed)


async def test_snapshot_bus_conflates_and_wakes():
    """wait() returns when a snapshot is published; current holds the latest."""
    bus = SnapshotBus()
    assert bus.current is None

    async with anyio.create_task_group() as tg:
        async def publisher():
            await anyio.sleep(0.01)
            bus.publish(make_snapshot(seq=1))

        tg.start_soon(publisher)
        with anyio.fail_after(1):
            await bus.wait(timeout=5)

    assert bus.current is not None
    assert bus.current.seq == 1


async def test_snapshot_bus_wait_times_out_without_publish():
    """wait() returns after the timeout even if nothing is published (no hang)."""
    bus = SnapshotBus()
    with anyio.fail_after(1):
        await bus.wait(timeout=0.01)
    assert bus.current is None


async def test_snapshot_bus_keeps_only_latest():
    """Rapid publishes conflate: current is the newest, intermediate values are dropped."""
    bus = SnapshotBus()
    bus.publish(make_snapshot(seq=1))
    bus.publish(make_snapshot(seq=2))
    bus.publish(make_snapshot(seq=3))
    assert bus.current.seq == 3
