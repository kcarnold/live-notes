"""Shared test doubles for the slide-sync runtime and seam tests.

These fake the three external boundaries so no real Proclaim or Y-Sweet is needed:
- ``FakeWebSocket`` / ``FakeProvider`` stand in for the Y-Sweet websocket + pycrdt Provider.
- ``FakeFeed`` is a scripted ``SlideFeed`` yielding canned snapshots (repeating the last).
"""

import contextlib
from datetime import date
from typing import List, Optional
from unittest import mock

import slide_sync_runtime as ssr
from slide_feed import FeedItem, FeedSnapshot, SessionInfo
from slide_sync_runtime import RuntimeTiming


class FakeWebSocket:
    """Stand-in for an httpx_ws AsyncWebSocketSession.

    ``ping`` records calls and can be made to fail after N pings to simulate a silently
    dropped connection (which is how the runtime detects disconnects).
    """

    def __init__(self, fail_ping_after=None):
        self.ping_count = 0
        self.fail_ping_after = fail_ping_after

    async def ping(self):
        self.ping_count += 1
        if self.fail_ping_after is not None and self.ping_count >= self.fail_ping_after:
            raise ssr.HTTPXWSException("websocket dropped")


class FakeProvider:
    """No-op stand-in for the pycrdt Provider context manager."""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeFeed:
    """A scripted SlideFeed. Pops the next snapshot each poll; repeats the last when exhausted."""

    def __init__(self, snapshots: List[FeedSnapshot]):
        assert snapshots, "FakeFeed needs at least one snapshot"
        self._snapshots = list(snapshots)
        self.reset_called = 0

    async def poll(self) -> FeedSnapshot:
        if len(self._snapshots) > 1:
            return self._snapshots.pop(0)
        return self._snapshots[0]

    def reset(self) -> None:
        self.reset_called += 1


@contextlib.contextmanager
def patched_connection(websocket):
    """Patch aconnect_ws/Provider so a session uses the given fake websocket."""
    @contextlib.asynccontextmanager
    async def fake_aconnect_ws(*args, **kwargs):
        yield websocket

    with mock.patch.object(ssr, "aconnect_ws", fake_aconnect_ws), \
         mock.patch.object(ssr, "Provider", FakeProvider):
        yield


def fast_timing() -> RuntimeTiming:
    """Runtime timing scaled down so loops complete near-instantly."""
    return RuntimeTiming(
        poll_interval=0.001,
        poll_interval_off_air=0.001,
        off_air_disconnect_after=0.005,
        reconnect_backoff_initial=0.001,
        reconnect_backoff_max=0.002,
        ws_ping_interval=0.0,  # ping every poll so the health-check path runs in-window
    )


def on_air_snap(item="item-1", slide=0, slides=("A", "B"), session_date: Optional[date] = None,
                presentation_id="pres-1") -> FeedSnapshot:
    return FeedSnapshot(
        on_air=True,
        session=SessionInfo(presentation_id=presentation_id, session_date=session_date),
        order=[item],
        items={item: FeedItem(item, "Title", list(slides), "Content", "h", None)},
        active_item_id=item,
        active_slide_index=slide,
        seq=1,
    )


def off_air_snap() -> FeedSnapshot:
    return FeedSnapshot(on_air=False, session=None)
