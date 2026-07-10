"""Tests for SlideSyncRuntime: lazy connect, off-air disconnect, reconnect-with-backoff,
state re-push on connect, doc-date resolution, and the all-three-resets doc rollover.

The feed, Y-Sweet websocket, and Provider are all faked (see tests/helpers.py)."""

import contextlib
from datetime import date
from unittest import mock

import anyio
import pytest

import slide_sync_runtime as ssr
from slide_feed import SessionInfo
from slide_sync_runtime import SlideSyncRuntime
from slide_translator import SlideTranslator
from yjs_publisher import YjsSlidePublisher
from helpers import (
    FakeFeed,
    FakeProvider,
    FakeWebSocket,
    fast_timing,
    off_air_snap,
    on_air_snap,
    patched_connection,
)

pytestmark = pytest.mark.anyio


def make_runtime(feed, doc_id="doc-test"):
    pub = YjsSlidePublisher()
    tr = SlideTranslator(
        translate_fn=mock.AsyncMock(return_value=None),
        languages=["French"],
        scan_interval=0.001,
    )
    rt = SlideSyncRuntime(feed, pub, tr, "http://localhost:8000", doc_id=doc_id, timing=fast_timing())
    rt.get_ysweet_token = mock.AsyncMock(return_value={"url": "ws://test"})
    return rt


def make_date_based_runtime(feed):
    pub = YjsSlidePublisher()
    tr = SlideTranslator(mock.AsyncMock(return_value=None), ["French"], 0.001)
    return SlideSyncRuntime(feed, pub, tr, "http://localhost:8000", timing=fast_timing())


async def test_wait_until_on_air_holds_no_connection():
    """While off air, the runtime must not open a Y-Sweet connection."""
    feed = FakeFeed([off_air_snap(), off_air_snap(), on_air_snap()])
    rt = make_runtime(feed)

    aconnect = mock.MagicMock()
    with mock.patch.object(ssr, "aconnect_ws", aconnect):
        with anyio.fail_after(2):
            await rt._wait_until_on_air()

    aconnect.assert_not_called()


async def test_wait_until_on_air_returns_session():
    """The on-air session is handed back so the caller can resolve the doc."""
    feed = FakeFeed([on_air_snap(session_date=date(2030, 1, 15))])
    rt = make_runtime(feed)

    with anyio.fail_after(2):
        session = await rt._wait_until_on_air()

    assert session.presentation_id == "pres-1"
    assert session.session_date == date(2030, 1, 15)


async def test_session_disconnects_after_sustained_off_air():
    """A sustained off-air period ends the session cleanly (returns, no raise)."""
    feed = FakeFeed([on_air_snap(), off_air_snap()])  # one on-air poll, then off air forever
    rt = make_runtime(feed)
    ws = FakeWebSocket()

    with patched_connection(ws):
        with anyio.fail_after(2):
            await rt._run_session()  # returns normally => clean disconnect


async def test_reconnects_after_websocket_drop():
    """A silently dropped websocket triggers reconnect-with-backoff, not death."""
    feed = FakeFeed([on_air_snap()])
    rt = make_runtime(feed)
    rt._wait_until_on_air = mock.AsyncMock(return_value=on_air_snap().session)

    websockets = [FakeWebSocket(fail_ping_after=2) for _ in range(5)]
    made = []

    @contextlib.asynccontextmanager
    async def fake_aconnect_ws(*args, **kwargs):
        ws = websockets[len(made)]
        made.append(ws)
        yield ws

    real_run_session = rt._run_session
    attempts = {"n": 0}

    async def counting_run_session():
        attempts["n"] += 1
        if attempts["n"] >= 3:
            raise KeyboardInterrupt
        return await real_run_session()

    rt._run_session = counting_run_session

    with mock.patch.object(ssr, "aconnect_ws", fake_aconnect_ws), \
         mock.patch.object(ssr, "Provider", FakeProvider):
        with contextlib.suppress(KeyboardInterrupt):
            with anyio.fail_after(3):
                await rt.run()

    assert attempts["n"] >= 3
    assert len(made) >= 2


async def test_reconnects_after_failed_token_fetch():
    """A cold/slow Y-Sweet (token fetch fails) is retried, not fatal."""
    feed = FakeFeed([on_air_snap()])
    rt = make_runtime(feed)
    rt._wait_until_on_air = mock.AsyncMock(return_value=on_air_snap().session)

    calls = {"n": 0}

    async def flaky_token():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ssr.httpx.ConnectError("y-sweet cold")
        raise KeyboardInterrupt

    rt.get_ysweet_token = flaky_token

    with contextlib.suppress(KeyboardInterrupt):
        with anyio.fail_after(3):
            await rt.run()

    assert calls["n"] >= 3


async def test_fresh_connection_repushes_current_state():
    """On (re)connect the current item/slide pointer is re-pushed to the new server."""
    feed = FakeFeed([on_air_snap(item="item-9", slide=1)])
    rt = make_runtime(feed)
    ws = FakeWebSocket(fail_ping_after=1)  # end the session right after the first push

    with patched_connection(ws):
        with contextlib.suppress(ssr.HTTPXWSException):
            with anyio.fail_after(2):
                await rt._run_session()

    assert rt.publisher.status_map["itemId"] == "item-9"
    assert rt.publisher.status_map["slideIndex"] == 1


def test_resolve_doc_uses_show_date():
    """Date-based doc is anchored to the on-air show's date, with a fresh Doc."""
    rt = make_date_based_runtime(FakeFeed([off_air_snap()]))
    old_doc = rt.ydoc

    rt._resolve_doc_for_session(SessionInfo("pres-1", date(2030, 1, 15)))

    assert rt.doc_id == "doc-2030-01-15"
    assert rt.doc_date_from_show is True
    assert rt.current_doc_date == date(2030, 1, 15)
    assert rt.ydoc is not old_doc
    assert rt._date_rolled_over() is False


def test_resolve_doc_falls_back_to_today_without_show_date():
    """A session with no date falls back to today and stays midnight-rollable."""
    rt = make_date_based_runtime(FakeFeed([off_air_snap()]))

    rt._resolve_doc_for_session(SessionInfo("pres-1", None))

    assert rt.doc_id == SlideSyncRuntime._get_date_based_doc_id(date.today())
    assert rt.doc_date_from_show is False
    assert rt.current_doc_date == date.today()


def test_resolve_doc_noop_with_explicit_doc_id():
    """An explicit doc_id override is left untouched (no Doc swap)."""
    rt = make_runtime(FakeFeed([off_air_snap()]))  # explicit doc_id="doc-test"
    old_doc = rt.ydoc

    rt._resolve_doc_for_session(SessionInfo("pres-1", date(2030, 1, 15)))

    assert rt.doc_id == "doc-test"
    assert rt.ydoc is old_doc
    assert rt.doc_date_from_show is False


def test_recreate_doc_resets_publisher_translator_and_feed():
    """Rolling to a new day rebinds both consumers to a fresh Doc and resets the feed."""
    feed = FakeFeed([off_air_snap()])
    rt = make_runtime(feed)
    rt.publisher._written_hashes = {"x": "h"}
    rt.translator._translated_hashes = {"x": "h"}
    old_doc = rt.ydoc

    rt._recreate_doc()

    assert rt.ydoc is not old_doc
    assert rt.publisher._written_hashes == {}
    assert rt.translator._translated_hashes == {}
    assert feed.reset_called == 1
    # Both consumers rebound to the new doc.
    assert rt.publisher.ydoc is rt.ydoc
    assert rt.translator.ydoc is rt.ydoc
