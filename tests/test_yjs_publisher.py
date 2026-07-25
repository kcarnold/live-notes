"""Tests for YjsSlidePublisher: write shape, slide clipping, write-diffing, and the
single-transaction guarantee that fixes #67."""

import logging

from pycrdt import Doc

from slide_feed import FeedItem, FeedSnapshot
from yjs_publisher import YjsSlidePublisher


def item(item_id="i1", title="Title", slides=("A", "B"), kind="Content", slides_hash="h1"):
    return FeedItem(item_id, title, list(slides), kind, slides_hash, None)


def snap(order=("i1",), items=None, active="i1", slide=0, on_air=True):
    items = items if items is not None else {"i1": item()}
    return FeedSnapshot(
        on_air=on_air, session=None, order=list(order), items=items,
        active_item_id=active, active_slide_index=slide, seq=1,
    )


def make_publisher(doc=None):
    doc = doc or Doc()
    pub = YjsSlidePublisher()
    pub.bind(doc)
    return pub, doc


def test_apply_writes_order_presentations_and_status():
    pub, _ = make_publisher()
    pub.apply(snap())

    assert list(pub.service_order_map["order"]) == ["i1"]
    p = pub.presentations_map["i1"]
    assert p["title"] == "Title"
    assert p["itemId"] == "i1"
    assert p["itemKind"] == "Content"
    assert p["slidesHash"] == "h1"
    assert list(p["slides"]) == ["A", "B"]
    assert pub.status_map["itemId"] == "i1"
    assert pub.status_map["slideIndex"] == 0


def test_apply_clips_slide_index_into_range():
    pub, _ = make_publisher()
    pub.apply(snap(slide=5))  # active item has 2 slides -> max index 1
    assert pub.status_map["slideIndex"] == 1

    pub.apply(snap(slide=-3))
    assert pub.status_map["slideIndex"] == 0


def test_identical_reapply_writes_nothing():
    """Write-diffing: re-applying the same snapshot produces no Yjs update (no churn)."""
    pub, doc = make_publisher()
    pub.apply(snap())

    events = []
    doc.observe(lambda e: events.append(e))
    pub.apply(snap())
    assert events == []


def test_order_presentation_and_status_land_in_one_transaction():
    """#67 regression: a cycle that changes a presentation AND the status pointer commits as
    a single transaction, so a viewer can never observe a half-applied (desynced) state."""
    pub, doc = make_publisher()
    pub.apply(snap(items={"i1": item()}, active="i1", slide=0))

    events = []
    doc.observe(lambda e: events.append(e))
    # New item content (new hash) + order grows + active pointer moves — all at once.
    new_items = {"i1": item(), "i2": item("i2", "Two", ("C",), slides_hash="h2")}
    pub.apply(snap(order=("i1", "i2"), items=new_items, active="i2", slide=0))

    assert len(events) == 1


def test_status_only_cycle_keeps_order_intact():
    """A status-only change doesn't blank the order (snapshots are always complete)."""
    pub, _ = make_publisher()
    pub.apply(snap(slide=0))
    pub.apply(snap(slide=1))

    assert pub.status_map["slideIndex"] == 1
    assert list(pub.service_order_map["order"]) == ["i1"]


def test_looping_blank_item_produces_no_writes():
    """A looping image slideshow keeps reporting advancing slide indices, but the item renders
    as a single blank slide. Clipping pins it to 0 and the status diff suppresses the writes,
    so the loop causes no Yjs churn and the pointer stays on slide 0."""
    blank = item(item_id="img1", title="Slideshow", slides=("",), kind="ImageSlideshow")
    pub, doc = make_publisher()
    pub.apply(snap(order=("img1",), items={"img1": blank}, active="img1", slide=0))

    events = []
    doc.observe(lambda e: events.append(e))
    for idx in (1, 2, 3):
        pub.apply(snap(order=("img1",), items={"img1": blank}, active="img1", slide=idx))

    assert events == []
    assert pub.status_map["slideIndex"] == 0


def test_blank_item_clipping_does_not_warn(caplog):
    """Clipping a looping slideshow is expected, not an anomaly — it must not emit a warning
    on every poll cycle. Real items with an out-of-range index still warn."""
    blank = item(item_id="img1", title="Slideshow", slides=("",), kind="ImageSlideshow")
    pub, _ = make_publisher()

    with caplog.at_level(logging.WARNING, logger="yjs_publisher"):
        pub.apply(snap(order=("img1",), items={"img1": blank}, active="img1", slide=7))
    assert caplog.records == []

    pub2, _ = make_publisher()
    with caplog.at_level(logging.WARNING, logger="yjs_publisher"):
        pub2.apply(snap(slide=7))  # normal 2-slide item
    assert len(caplog.records) == 1


def test_normal_item_still_pushes_slide_changes():
    """A real multi-slide item must still push slide-index changes."""
    pub, _ = make_publisher()
    pub.apply(snap(slide=0))
    pub.apply(snap(slide=1))
    assert pub.status_map["slideIndex"] == 1


def test_bind_forces_full_republish_on_fresh_doc():
    """After rebinding to a fresh Doc, the next apply re-pushes everything (reconnect case)."""
    pub, _ = make_publisher()
    pub.apply(snap())

    fresh = Doc()
    pub.bind(fresh)
    pub.apply(snap())  # same snapshot, but the new doc is empty and must be fully written

    assert list(pub.service_order_map["order"]) == ["i1"]
    assert pub.presentations_map["i1"]["slidesHash"] == "h1"
    assert pub.status_map["itemId"] == "i1"
