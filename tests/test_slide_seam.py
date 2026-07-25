"""Seam test: replayed feed output drives the REAL consumers with no source in the loop.

This is issue #70's "simulated proclaim" in miniature — the load-bearing proof that the
feed→consumer boundary is real. A list of recorded ``FeedSnapshot``s is round-tripped through
JSON (proving the recorded form is what drives the consumers), then fanned out to a real
``YjsSlidePublisher`` and a real ``SlideTranslator`` on a single Y.Doc, exactly as the runtime
does. We then assert the doc holds the expected order/presentations/status/translations."""

from datetime import date

import anyio
import pytest
from pycrdt import Doc

from proclaim_lib import slide_translation_key, slides_hash
from slide_feed import FeedItem, FeedSnapshot, SessionInfo, SnapshotBus
from slide_translator import SlideTranslator
from yjs_publisher import YjsSlidePublisher

pytestmark = pytest.mark.anyio

LANGS = ["French", "Spanish"]


def recorded_snapshots():
    """A tiny 'recorded' service: two items, the active pointer on the second."""
    return [
        FeedSnapshot(
            on_air=True,
            session=SessionInfo("pres-1", date(2030, 1, 15)),
            order=["i1", "i2"],
            items={
                "i1": FeedItem("i1", "Call", ["Come", "Worship"], "Content",
                               slides_hash(["Come", "Worship"]), None),
                "i2": FeedItem("i2", "Song", ["Sing"], "SongLyrics",
                               slides_hash(["Sing"]), None),
            },
            active_item_id="i2",
            active_slide_index=0,
            seq=1,
        ),
    ]


async def test_replayed_snapshots_drive_real_consumers():
    doc = Doc()
    pub = YjsSlidePublisher()
    pub.bind(doc)

    async def translate_fn(slides, title, item_id, existing, doc_id):
        return {
            lang: [{"text": f"{lang}:{s}", "status": "auto", "provenance": "llm"} for s in slides]
            for lang in LANGS
        }

    tr = SlideTranslator(translate_fn, LANGS, scan_interval=0.001)
    tr.bind(doc)
    bus = SnapshotBus()

    # Round-trip through JSON so the *recorded* form is what drives the consumers.
    replay = [FeedSnapshot.from_json(s.to_json()) for s in recorded_snapshots()]

    expected_keys = [
        slide_translation_key(lang, slide)
        for lang in LANGS
        for snap in replay
        for item in snap.items.values()
        for slide in item.slides
    ]

    async with anyio.create_task_group() as tg:
        tg.start_soon(tr.run, bus)

        # The runtime's fan-out: apply to the publisher (inline) + publish to the bus.
        for snap in replay:
            pub.apply(snap)
            bus.publish(snap)

        with anyio.fail_after(2):
            while not all(k in tr.translations_map for k in expected_keys):
                await anyio.sleep(0.005)

        tg.cancel_scope.cancel()

    # Both consumers wrote into the same doc.
    assert doc is pub.ydoc is tr.ydoc

    # Publisher side: order + presentations + status.
    assert list(pub.service_order_map["order"]) == ["i1", "i2"]
    assert pub.presentations_map["i1"]["slidesHash"] == slides_hash(["Come", "Worship"])
    assert list(pub.presentations_map["i1"]["slides"]) == ["Come", "Worship"]
    assert pub.presentations_map["i2"]["itemKind"] == "SongLyrics"
    assert pub.status_map["itemId"] == "i2"
    assert pub.status_map["slideIndex"] == 0

    # Translator side: every slide × language covered, on the same doc.
    for key in expected_keys:
        assert key in tr.translations_map
    assert tr.translations_map[slide_translation_key("French", "Sing")]["text"] == "French:Sing"
    assert tr.translations_map[slide_translation_key("Spanish", "Come")]["text"] == "Spanish:Come"
