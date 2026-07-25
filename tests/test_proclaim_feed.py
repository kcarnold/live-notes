"""Tests for ProclaimFeed: snapshot production, revision-gated re-parse, session date,
and existing-translation grounding. The Proclaim HTTP calls and DB are faked."""

from datetime import date
from unittest import mock

import pytest

import proclaim_feed as pf
from proclaim_feed import ProclaimFeed
from proclaim_lib import ServiceItemWithSlides

pytestmark = pytest.mark.anyio


def make_feed(order_sync_interval: float = 0.0) -> ProclaimFeed:
    """Build a feed with the DB faked and the order always eligible to sync."""
    db = mock.MagicMock()
    db.get_presentation.return_value = None
    return ProclaimFeed(db=db, order_sync_interval=order_sync_interval)


def onair_status(item_id="i1", slide_index=0, presentation_id="pres-1"):
    return {"status": {"itemId": item_id, "slideIndex": slide_index}, "presentationId": presentation_id}


def presentation_with(items):
    return {"serviceItems": items}


async def test_poll_off_air_returns_empty_pointer_snapshot():
    """When Proclaim is off air, poll() reports on_air=False and no active pointer."""
    feed = make_feed()
    feed._fetch_status = mock.AsyncMock(return_value=None)

    snap = await feed.poll()

    assert snap.on_air is False
    assert snap.active_item_id is None
    assert snap.active_slide_index is None


async def test_poll_syncs_order_and_caches_revisions():
    """poll() pushes every item's slides + order, re-parsing only changed revisions."""
    feed = make_feed(order_sync_interval=0.0)
    feed._fetch_status = mock.AsyncMock(return_value=onair_status())
    presentation = presentation_with([
        {"id": "i1", "title": "Call to Worship", "kind": "Content",
         "slides": [{"localRevision": 1}, {"localRevision": 2}]},
        {"id": "i2", "title": "Song", "kind": "SongLyrics", "slides": [{"localRevision": 9}]},
    ])
    feed._fetch_onair_presentation = mock.AsyncMock(return_value=presentation)

    parsed = {
        "i1": ServiceItemWithSlides("i1", "Call to Worship", ["A", "B"], "Content"),
        "i2": ServiceItemWithSlides("i2", "Song", ["C"], "SongLyrics"),
    }
    calls = []

    def fake_parse(_db, item_id):
        calls.append(item_id)
        return parsed[item_id]

    with mock.patch.object(pf, "parse_item_original", fake_parse):
        snap = await feed.poll()
        assert snap.order == ["i1", "i2"]
        assert snap.items["i1"].slides == ["A", "B"]
        assert snap.items["i1"].item_kind == "Content"
        assert snap.items["i1"].slides_hash
        assert calls == ["i1", "i2"]

        # Unchanged revisions => no re-parse.
        await feed.poll()
        assert calls == ["i1", "i2"]

        # Change i1's revision => only i1 is re-parsed.
        presentation["serviceItems"][0]["slides"][0]["localRevision"] = 5
        await feed.poll()
        assert calls == ["i1", "i2", "i1"]


async def test_poll_force_syncs_when_active_item_uncached():
    """Even before the throttle elapses, an unseen active item forces an order fetch."""
    feed = make_feed(order_sync_interval=999.0)  # throttle would otherwise block a sync
    feed._fetch_status = mock.AsyncMock(return_value=onair_status(item_id="i1"))
    presentation = presentation_with([
        {"id": "i1", "title": "X", "kind": "Content", "slides": [{"localRevision": 1}]},
    ])
    feed._fetch_onair_presentation = mock.AsyncMock(return_value=presentation)

    with mock.patch.object(
        pf, "parse_item_original",
        lambda _db, i: ServiceItemWithSlides(i, "X", ["A"], "Content"),
    ):
        snap = await feed.poll()

    assert "i1" in snap.items
    feed._fetch_onair_presentation.assert_awaited()


async def test_poll_carries_session_date_from_date_given():
    """The snapshot's session reflects the show's DateGiven, read once per presentation."""
    feed = make_feed(order_sync_interval=999.0)
    feed._fetch_status = mock.AsyncMock(return_value=onair_status(presentation_id="pres-1"))
    feed._fetch_onair_presentation = mock.AsyncMock(return_value=None)
    feed.db.get_presentation.return_value = {"date_given": "2030-01-15", "content": {}}

    snap = await feed.poll()

    assert snap.session.presentation_id == "pres-1"
    assert snap.session.session_date == date(2030, 1, 15)


def test_update_session_reads_date_given_once_per_presentation():
    """Session date is cached per presentation id (no repeated DB reads)."""
    feed = make_feed()
    feed.db.get_presentation.return_value = {"date_given": "2030-01-15", "content": {}}

    feed._update_session("pres-1")
    feed._update_session("pres-1")

    assert feed._session.session_date == date(2030, 1, 15)
    assert feed.db.get_presentation.call_count == 1


def test_existing_translation_screen_idx_cached_per_presentation():
    """The translation-screen index is computed once per presentation, reused per item."""
    feed = make_feed()
    feed._presentation_id = "pres-1"
    feed.db.get_presentation = mock.MagicMock(return_value={"content": {"VirtualScreens": "[]"}})

    with mock.patch.object(pf, "get_translation_screen_idx", return_value=2) as gti, \
         mock.patch.object(pf, "existing_translation_text", side_effect=lambda db, item, idx: f"{item}:{idx}"):
        assert feed._existing_translation_for("i1") == "i1:2"
        assert feed._existing_translation_for("i2") == "i2:2"

    assert gti.call_count == 1
    assert feed.db.get_presentation.call_count == 1


def test_existing_translation_stamped_on_feed_item():
    """_to_feed_item pulls the item's existing translation onto the FeedItem."""
    feed = make_feed()
    feed._presentation_id = "pres-1"
    feed.db.get_presentation = mock.MagicMock(return_value={"content": {"VirtualScreens": "[]"}})

    with mock.patch.object(pf, "get_translation_screen_idx", return_value=1), \
         mock.patch.object(pf, "existing_translation_text", return_value="Bonjou"):
        item = feed._to_feed_item(ServiceItemWithSlides("i1", "Song", ["Hello"], "Content"))

    assert item.existing_translation == "Bonjou"
    assert item.slides_hash


def test_parse_date_given_variants():
    """DateGiven parsing accepts plain dates (and a stray time), rejects junk."""
    parse = ProclaimFeed._parse_date_given
    assert parse("2025-03-02") == date(2025, 3, 2)
    assert parse("2025-03-02T10:30:00") == date(2025, 3, 2)
    assert parse("2025-03-02 10:30") == date(2025, 3, 2)
    assert parse("") is None
    assert parse("not-a-date") is None
    assert parse(None) is None


def test_reset_clears_caches():
    """reset() drops parsed items, revisions, order, session, and screen-idx caches."""
    feed = make_feed()
    feed._items = {"i1": object()}
    feed._item_revisions = {"i1": "r"}
    feed._order = ["i1"]
    feed._session_pres_id = "pres-1"
    feed._translation_screen_idx = 3

    feed.reset()

    assert feed._items == {}
    assert feed._item_revisions == {}
    assert feed._order == []
    assert feed._session_pres_id is None
    assert feed._translation_screen_idx is None
