"""Tests for the Proclaim service connection lifecycle and resilience.

These exercise the robustness guarantees of ``proclaim_service`` without needing
a real Proclaim install or Y-Sweet server: the Proclaim DB, the Y-Sweet
websocket (``aconnect_ws``), and the Yjs ``Provider`` are all faked, and timing
constants are scaled down so the loops run in milliseconds.

Covered behaviors:
- Lazy connect: no Y-Sweet connection is opened while off air.
- Off-air disconnect: a sustained off-air period drops the connection cleanly.
- Auto-reconnect: a silently dropped websocket and a failed token fetch both
  lead to a retry-with-backoff instead of a dead service.
- State re-push: a fresh connection re-pushes the current item/slide.
"""

import contextlib
from unittest import mock

import anyio
import pytest

import proclaim_service as ps

pytestmark = pytest.mark.anyio


class FakeWebSocket:
    """Stand-in for an httpx_ws AsyncWebSocketSession.

    ``ping`` records calls and can be made to fail after N pings to simulate a
    silently dropped connection (which is how the service detects disconnects).
    """

    def __init__(self, fail_ping_after=None):
        self.ping_count = 0
        self.fail_ping_after = fail_ping_after

    async def ping(self):
        self.ping_count += 1
        if self.fail_ping_after is not None and self.ping_count >= self.fail_ping_after:
            raise ps.HTTPXWSException("websocket dropped")


class FakeProvider:
    """No-op stand-in for the pycrdt Provider context manager."""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def fast_timing(monkeypatch):
    """Scale down the service's timing so loops complete near-instantly."""
    monkeypatch.setattr(ps, "POLL_INTERVAL", 0.001)
    monkeypatch.setattr(ps, "POLL_INTERVAL_OFF_AIR", 0.001)
    monkeypatch.setattr(ps, "OFF_AIR_DISCONNECT_AFTER", 0.005)
    monkeypatch.setattr(ps, "RECONNECT_BACKOFF_INITIAL", 0.001)
    monkeypatch.setattr(ps, "RECONNECT_BACKOFF_MAX", 0.002)
    # Ping every poll so the health-check path is exercised within the test window.
    monkeypatch.setattr(ps, "WS_PING_INTERVAL", 0.0)


def make_service():
    """Build a service with the Proclaim DB mocked out."""
    with mock.patch.object(ps, "ProclaimDB"):
        service = ps.ProclaimYjsService("http://localhost:8000", doc_id="doc-test")
    service.get_ysweet_token = mock.AsyncMock(return_value={"url": "ws://test"})
    # The full service-order sync hits Proclaim's HTTP API + DB; stub the fetch to a
    # no-op so lifecycle tests need neither. _apply_status itself touches neither.
    service._fetch_onair_presentation = mock.AsyncMock(return_value=None)
    # Translation makes an HTTP call to the server; stub it for lifecycle tests.
    service._translate_item = mock.AsyncMock(return_value=None)
    return service


@contextlib.contextmanager
def patched_connection(websocket):
    """Patch aconnect_ws/Provider so a session uses the given fake websocket."""
    @contextlib.asynccontextmanager
    async def fake_aconnect_ws(*args, **kwargs):
        yield websocket

    with mock.patch.object(ps, "aconnect_ws", fake_aconnect_ws), \
         mock.patch.object(ps, "Provider", FakeProvider):
        yield


def status(item_id="item-1", slide_index=0):
    return {"status": {"itemId": item_id, "slideIndex": slide_index}, "presentationId": "pres-1"}


async def test_wait_until_on_air_holds_no_connection(fast_timing):
    """While off air, the service must not open a Y-Sweet connection."""
    service = make_service()
    fetches = iter([None, None, status()])

    async def fetch():
        try:
            return next(fetches)
        except StopIteration:
            return status()

    service._fetch_status = fetch

    aconnect = mock.MagicMock()
    with mock.patch.object(ps, "aconnect_ws", aconnect):
        with anyio.fail_after(2):
            await service._wait_until_on_air()

    # It returned only once on air, and never touched the websocket while waiting.
    aconnect.assert_not_called()


async def test_session_disconnects_after_sustained_off_air(fast_timing):
    """A sustained off-air period ends the session cleanly (returns, no raise)."""
    service = make_service()
    # One on-air poll, then off air forever.
    statuses = iter([status()])

    async def fetch():
        try:
            return next(statuses)
        except StopIteration:
            return None

    service._fetch_status = fetch
    ws = FakeWebSocket()

    with patched_connection(ws):
        with anyio.fail_after(2):
            await service._run_session()  # returns normally => clean disconnect


async def test_reconnects_after_websocket_drop(fast_timing):
    """A silently dropped websocket triggers reconnect-with-backoff, not death."""
    service = make_service()
    service._fetch_status = mock.AsyncMock(return_value=status())
    service._wait_until_on_air = mock.AsyncMock()

    # Each session connects with a websocket that dies on its 2nd ping.
    websockets = [FakeWebSocket(fail_ping_after=2) for _ in range(5)]
    made = []

    @contextlib.asynccontextmanager
    async def fake_aconnect_ws(*args, **kwargs):
        ws = websockets[len(made)]
        made.append(ws)
        yield ws

    # Stop the otherwise-infinite run() loop after a few reconnects.
    real_run_session = service._run_session
    attempts = {"n": 0}

    async def counting_run_session():
        attempts["n"] += 1
        if attempts["n"] >= 3:
            raise KeyboardInterrupt
        return await real_run_session()

    service._run_session = counting_run_session

    with mock.patch.object(ps, "aconnect_ws", fake_aconnect_ws), \
         mock.patch.object(ps, "Provider", FakeProvider):
        with contextlib.suppress(KeyboardInterrupt):
            with anyio.fail_after(3):
                await service.run()

    # The service survived the drops and kept reconnecting.
    assert attempts["n"] >= 3
    assert len(made) >= 2


async def test_reconnects_after_failed_token_fetch(fast_timing):
    """A cold/slow Y-Sweet (token fetch fails) is retried, not fatal."""
    service = make_service()
    service._wait_until_on_air = mock.AsyncMock()

    calls = {"n": 0}

    async def flaky_token():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ps.httpx.ConnectError("y-sweet cold")
        raise KeyboardInterrupt  # break out once we've proven it retried

    service.get_ysweet_token = flaky_token

    with contextlib.suppress(KeyboardInterrupt):
        with anyio.fail_after(3):
            await service.run()

    assert calls["n"] >= 3  # retried the failed token fetch instead of dying


async def test_fresh_connection_repushes_current_state(fast_timing):
    """On (re)connect the current item/slide pointer is re-pushed to the new server."""
    service = make_service()
    service._fetch_status = mock.AsyncMock(return_value=status(item_id="item-9", slide_index=4))
    ws = FakeWebSocket(fail_ping_after=1)  # die after first push so the session ends fast

    with patched_connection(ws):
        with contextlib.suppress(ps.HTTPXWSException):
            with anyio.fail_after(2):
                await service._run_session()

    # last_item_id was reset to None on connect, so the first poll re-pushes the
    # current item/slide pointer into proclaimStatus.
    assert service.status_map["itemId"] == "item-9"
    assert service.status_map["slideIndex"] == 4


def test_sync_service_order_pushes_items_and_caches_revisions():
    """The full-order sync pushes every item's original slides + a service order, and
    only re-parses items whose localRevision signature changed."""
    from proclaim_lib import ServiceItemWithSlides

    service = make_service()
    parsed = {
        'i1': ServiceItemWithSlides('i1', 'Call to Worship', ['A', 'B'], 'Content'),
        'i2': ServiceItemWithSlides('i2', 'Song', ['C'], 'SongLyrics'),
    }
    calls = []

    def fake_parse(_db, item_id):
        calls.append(item_id)
        return parsed[item_id]

    presentation = {
        'serviceItems': [
            {'id': 'i1', 'title': 'Call to Worship', 'kind': 'Content',
             'slides': [{'localRevision': 1}, {'localRevision': 2}]},
            {'id': 'i2', 'title': 'Song', 'kind': 'SongLyrics', 'slides': [{'localRevision': 9}]},
        ]
    }

    with mock.patch.object(ps, 'parse_item_original', fake_parse):
        service._sync_service_order(presentation)
        assert list(service.service_order_map['order']) == ['i1', 'i2']
        assert list(service.presentations_map['i1']['slides']) == ['A', 'B']
        assert service.presentations_map['i1']['slidesHash']
        assert calls == ['i1', 'i2']

        # Unchanged revisions => no re-parse.
        service._sync_service_order(presentation)
        assert calls == ['i1', 'i2']

        # Change i1's revision => only i1 is re-parsed (slides changed underneath us).
        presentation['serviceItems'][0]['slides'][0]['localRevision'] = 5
        service._sync_service_order(presentation)
        assert calls == ['i1', 'i2', 'i1']


def test_store_translations_writes_content_addressed_keys():
    """Per-slide results land in slideTranslations under language:normalized-text keys."""
    from proclaim_lib import slide_translation_key

    service = make_service()
    service._store_translations(
        ['Hello', '', 'World'],
        {
            'French': [
                {'text': 'Bonjour', 'status': 'auto', 'provenance': 'llm'},
                {'text': '', 'status': 'auto', 'provenance': 'llm'},
                {'text': 'Monde', 'status': 'reviewed', 'provenance': 'human'},
            ]
        },
    )
    hello = service.slide_translations_map[slide_translation_key('French', 'Hello')]
    assert hello['text'] == 'Bonjour'
    assert hello['status'] == 'auto'
    world = service.slide_translations_map[slide_translation_key('French', 'World')]
    assert world['status'] == 'reviewed'
    # The empty slide is skipped.
    assert slide_translation_key('French', '') not in service.slide_translations_map


async def test_translate_active_item_translates_once_per_revision(fast_timing):
    """The active item is translated only when its revision changes."""
    from proclaim_lib import ServiceItemWithSlides, slide_translation_key

    service = make_service()
    service.items_by_id['i1'] = ServiceItemWithSlides('i1', 'Song', ['Hello'], 'Content')
    service.item_revisions['i1'] = 'r1'
    service._translate_item = mock.AsyncMock(
        return_value={'French': [{'text': 'Bonjour', 'status': 'auto', 'provenance': 'llm'}]}
    )

    await service._translate_active_item('i1')
    assert service._translate_item.await_count == 1
    assert service.slide_translations_map[slide_translation_key('French', 'Hello')]['text'] == 'Bonjour'

    # Same revision => no re-translation.
    await service._translate_active_item('i1')
    assert service._translate_item.await_count == 1

    # Changed revision => re-translate.
    service.item_revisions['i1'] = 'r2'
    await service._translate_active_item('i1')
    assert service._translate_item.await_count == 2


def test_recreate_doc_resets_state():
    """Rolling to a new day's document starts from a clean Doc and clean tracking."""
    service = make_service()
    service.last_item_id = "x"
    service.last_slide_index = 7
    service.current_item_slides = object()
    old_doc = service.ydoc

    service._recreate_doc()

    assert service.ydoc is not old_doc
    assert service.last_item_id is None
    assert service.last_slide_index is None
    assert service.current_item_slides is None
