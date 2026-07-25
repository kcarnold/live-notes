"""Tests for SlideTranslator: content-addressed seeding, never-clobber-reviewed, active-first
scan, attempt-once-per-content, and grounding forwarded from the snapshot."""

from unittest import mock

import anyio
import pytest
from pycrdt import Doc

from proclaim_lib import slide_translation_key, slides_hash
from slide_feed import FeedItem, FeedSnapshot, SnapshotBus
from slide_translator import SlideTranslator

pytestmark = pytest.mark.anyio

LANGS = ["French", "Spanish"]


def make_translator(translate_fn=None, scan_interval=0.0):
    doc = Doc()
    tr = SlideTranslator(
        translate_fn=translate_fn or mock.AsyncMock(return_value=None),
        languages=LANGS,
        scan_interval=scan_interval,
    )
    tr.bind(doc)
    return tr, doc


def feed_item(item_id, title, slides, existing=None):
    return FeedItem(item_id, title, list(slides), "Content", slides_hash(list(slides)), existing)


def snap(order, items, active=None, slide=0):
    return FeedSnapshot(
        on_air=True, session=None, order=list(order), items=items,
        active_item_id=active, active_slide_index=slide, seq=1,
    )


def auto_result(slides):
    return {lang: [{"text": f"{lang}:{s}", "status": "auto", "provenance": "llm"} for s in slides]
            for lang in LANGS}


def test_store_translations_writes_content_addressed_keys():
    tr, _ = make_translator()
    tr._store_translations(
        ["Hello", "", "World"],
        {"French": [
            {"text": "Bonjour", "status": "auto", "provenance": "llm"},
            {"text": "", "status": "auto", "provenance": "llm"},
            {"text": "Monde", "status": "reviewed", "provenance": "human"},
        ]},
    )
    hello = tr.translations_map[slide_translation_key("French", "Hello")]
    assert hello["text"] == "Bonjour"
    assert hello["status"] == "auto"
    assert tr.translations_map[slide_translation_key("French", "World")]["status"] == "reviewed"
    assert slide_translation_key("French", "") not in tr.translations_map


def test_store_translations_never_clobbers_reviewed():
    tr, _ = make_translator()
    hello_key = slide_translation_key("French", "Hello")
    world_key = slide_translation_key("French", "World")
    tr.translations_map[hello_key] = {"text": "Bonjour (édité)", "status": "reviewed", "provenance": "human"}
    tr.translations_map[world_key] = {"text": "Monde (ancien)", "status": "auto", "provenance": "llm"}

    tr._store_translations(
        ["Hello", "World"],
        {"French": [
            {"text": "Bonjour (re-traduit)", "status": "auto", "provenance": "llm"},
            {"text": "Monde (nouveau)", "status": "auto", "provenance": "llm"},
        ]},
    )

    assert tr.translations_map[hello_key]["text"] == "Bonjour (édité)"
    assert tr.translations_map[hello_key]["status"] == "reviewed"
    assert tr.translations_map[world_key]["text"] == "Monde (nouveau)"


def test_scan_order_rotates_active_first():
    tr, _ = make_translator()
    s = snap(["i1", "i2", "i3", "i4"], {}, active="i3")
    assert tr._scan_order(s) == ["i3", "i4", "i1", "i2"]

    s2 = snap(["i1", "i2", "i3", "i4"], {}, active="unknown")
    assert tr._scan_order(s2) == ["i1", "i2", "i3", "i4"]


async def test_translate_pending_translates_misses_active_first():
    translated = []

    async def fake(slides, title, item_id, existing, doc_id):
        translated.append(item_id)
        return auto_result(slides)

    tr, _ = make_translator(fake)
    s = snap(
        ["i1", "i2"],
        {"i1": feed_item("i1", "Past", ["Past slide"]),
         "i2": feed_item("i2", "Active", ["Active slide"])},
        active="i2",
    )

    assert await tr._translate_pending(s) is True
    assert translated == ["i2"]  # active first, even though later in the order
    for lang in LANGS:
        assert slide_translation_key(lang, "Active slide") in tr.translations_map

    assert await tr._translate_pending(s) is True
    assert translated == ["i2", "i1"]

    assert await tr._translate_pending(s) is False  # everything covered


async def test_translate_pending_skips_fully_covered():
    tr, _ = make_translator()  # translate_fn returns None
    for lang in LANGS:
        tr.translations_map[slide_translation_key(lang, "Hello")] = {
            "text": "x", "status": "auto", "provenance": "llm"
        }
    s = snap(["i1"], {"i1": feed_item("i1", "X", ["Hello"])}, active="i1")

    assert await tr._translate_pending(s) is False
    tr.translate_fn.assert_not_awaited()
    assert tr._translated_hashes["i1"] == slides_hash(["Hello"])


async def test_translate_pending_attempts_each_content_once():
    tr, _ = make_translator()  # translate_fn returns None (fails)
    s1 = snap(["i1"], {"i1": feed_item("i1", "X", ["Hello"])}, active="i1")

    assert await tr._translate_pending(s1) is True
    assert await tr._translate_pending(s1) is False  # same content => no retry
    assert tr.translate_fn.await_count == 1

    s2 = snap(["i1"], {"i1": feed_item("i1", "X", ["Hello there"])}, active="i1")
    assert await tr._translate_pending(s2) is True  # content changed => fresh attempt
    assert tr.translate_fn.await_count == 2


async def test_existing_translation_from_snapshot_forwarded():
    captured = {}

    async def fake(slides, title, item_id, existing, doc_id):
        captured["existing"] = existing
        return auto_result(slides)

    tr, _ = make_translator(fake)
    s = snap(["i1"], {"i1": feed_item("i1", "Song", ["Hello"], existing="Bonjou")}, active="i1")
    await tr._translate_pending(s)

    assert captured["existing"] == "Bonjou"


async def test_bound_doc_id_forwarded_to_translate_fn():
    """The server writes the agent conversation into the doc named by docId, so the currently
    bound doc id must reach the translate call — including after a rollover rebinds the doc."""
    captured = []

    async def fake(slides, title, item_id, existing, doc_id):
        captured.append(doc_id)
        return auto_result(slides)

    tr, _ = make_translator(fake)
    tr.bind(Doc(), "doc-2026-07-25")
    await tr._translate_pending(snap(["i1"], {"i1": feed_item("i1", "X", ["Hello"])}, active="i1"))

    # A date rollover rebinds to a fresh doc; the next call must carry the new id.
    tr.bind(Doc(), "doc-2026-07-26")
    await tr._translate_pending(snap(["i1"], {"i1": feed_item("i1", "X", ["Hello"])}, active="i1"))

    assert captured == ["doc-2026-07-25", "doc-2026-07-26"]


async def test_run_translates_from_bus():
    """The background loop picks up a published snapshot and translates it."""
    bus = SnapshotBus()
    translated = []

    async def fake(slides, title, item_id, existing, doc_id):
        translated.append(item_id)
        return auto_result(slides)

    tr, _ = make_translator(fake, scan_interval=0.01)
    bus.publish(snap(["i1"], {"i1": feed_item("i1", "X", ["Hello"])}, active="i1"))

    async with anyio.create_task_group() as tg:
        tg.start_soon(tr.run, bus)
        with anyio.fail_after(2):
            while "i1" not in translated:
                await anyio.sleep(0.005)
        tg.cancel_scope.cancel()

    assert translated == ["i1"]
