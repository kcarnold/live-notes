"""Integration tests for the Proclaim parsing pipeline.

These tests run against all snapshots in proclaim_snapshots/ (parametrized via conftest).
"""

import json
from pathlib import Path
from typing import Optional

import pytest

from proclaim_lib import (
    get_translation_screen_idx,
    item_to_yjs_dict,
    parse_item_translation,
)
from tests.conftest import MockProclaimDB

SYNTHETIC = Path(__file__).parent / "proclaim_snapshots" / "2026-01-05_synthetic.json"


# ---------------------------------------------------------------------------
# Generic tests — run against every snapshot
# ---------------------------------------------------------------------------


def test_translation_screen_detected(snapshot: dict, translation_idx: Optional[int]):
    """Every snapshot must have exactly one translation screen."""
    assert translation_idx is not None, "Expected a translation screen in VirtualScreens"


SKIPPED_KINDS = {"Grouping"}  # organizational items with no slide content


def test_all_items_parse_without_error(snapshot: dict, db: MockProclaimDB, translation_idx: Optional[int]):
    """Parsing must not raise for any item (may return None for structural items)."""
    assert translation_idx is not None
    for item in snapshot["service_items"]:
        if item["ServiceItemKind"] in SKIPPED_KINDS:
            continue
        result = parse_item_translation(db, item["ServiceItemId"], translation_idx)
        assert result is not None, f"parse_item_translation returned None for {item['ServiceItemId']} ({item['Title']})"


def test_blank_items_produce_single_blank_slide(snapshot: dict, db: MockProclaimDB, translation_idx: Optional[int]):
    assert translation_idx is not None
    blank_kinds = {"ImageSlideshow"}
    blank_titles = {"blank", "ncf slide", "offering slide"}
    for item in snapshot["service_items"]:
        if item["ServiceItemKind"] in SKIPPED_KINDS:
            continue
        is_blank = (
            item["ServiceItemKind"] in blank_kinds
            or item["Title"].lower() in blank_titles
        )
        if is_blank:
            result = parse_item_translation(db, item["ServiceItemId"], translation_idx)
            assert result is not None
            assert result.slides == [""], (
                f"Blank item {item['ServiceItemId']} should have slides=[''], got {result.slides}"
            )


def test_non_blank_items_have_nonempty_slides(snapshot: dict, db: MockProclaimDB, translation_idx: Optional[int]):
    assert translation_idx is not None
    blank_kinds = {"ImageSlideshow"}
    blank_titles = {"blank", "ncf slide", "offering slide"}
    for item in snapshot["service_items"]:
        if item["ServiceItemKind"] in SKIPPED_KINDS:
            continue
        is_blank = (
            item["ServiceItemKind"] in blank_kinds
            or item["Title"].lower() in blank_titles
        )
        if not is_blank:
            result = parse_item_translation(db, item["ServiceItemId"], translation_idx)
            assert result is not None, f"parse returned None for {item['ServiceItemId']} ({item['Title']})"
            assert any(s.strip() for s in result.slides), (
                f"Non-blank item {item['ServiceItemId']} has no non-empty slides: {result.slides}"
            )


def test_yjs_dict_has_required_keys(snapshot: dict, db: MockProclaimDB, translation_idx: Optional[int]):
    """The dict written to Yjs must have the expected shape."""
    assert translation_idx is not None
    for item in snapshot["service_items"]:
        if item["ServiceItemKind"] in SKIPPED_KINDS:
            continue
        result = parse_item_translation(db, item["ServiceItemId"], translation_idx)
        assert result is not None, f"parse returned None for {item['ServiceItemId']} ({item['Title']})"
        d = item_to_yjs_dict(result)
        assert isinstance(d["title"], str)
        assert isinstance(d["itemId"], str)
        assert isinstance(d["itemKind"], str)
        assert isinstance(d["slides"], list)
        assert all(isinstance(s, str) for s in d["slides"])
        assert isinstance(d["sourceSlides"], list)
        assert all(isinstance(s, str) for s in d["sourceSlides"])
        if "storedTranslation" in d:
            assert isinstance(d["storedTranslation"], list)
            assert all(isinstance(s, str) for s in d["storedTranslation"])


# ---------------------------------------------------------------------------
# Synthetic-fixture-specific tests
# ---------------------------------------------------------------------------


@pytest.fixture
def syn():
    data = json.loads(SYNTHETIC.read_text())
    db = MockProclaimDB(data)
    idx = get_translation_screen_idx(data["presentation_content"])
    return db, idx


def test_translation_screen_is_index_1(syn):
    _, idx = syn
    assert idx == 1


def test_song_title_is_first_slide(syn):
    db, idx = syn
    result = parse_item_translation(db, "song001", idx)
    assert result is not None
    assert result.slides[0] == "Beautiful Savior"


def test_song_custom_order_v1_c_v2(syn):
    db, idx = syn
    result = parse_item_translation(db, "song001", idx)
    assert result is not None
    # Title + 3 sections (v1, chorus, v2) from custom order "v1,c,v2"
    assert len(result.slides) == 4


def test_song_uses_french_translation_screen(syn):
    db, idx = syn
    result = parse_item_translation(db, "song001", idx)
    assert result is not None
    # French content should appear somewhere in slides
    french_content = any("Ligne" in slide or "Refrain" in slide for slide in result.slides)
    assert french_content, f"Expected French content in slides: {result.slides}"


def test_content_delimiter_splitting(syn):
    db, idx = syn
    result = parse_item_translation(db, "content001", idx)
    assert result is not None
    # Content uses '--' delimiter → 3 slides
    assert len(result.slides) == 3


def test_content_uses_french_translation(syn):
    db, idx = syn
    result = parse_item_translation(db, "content001", idx)
    assert result is not None
    assert any("texte" in slide.lower() for slide in result.slides), (
        f"Expected French content in slides: {result.slides}"
    )


def test_bible_falls_back_to_source(syn):
    db, idx = syn
    result = parse_item_translation(db, "bible001", idx)
    assert result is not None
    # No translation screen for Bible → falls back to Passage
    assert any("John" in slide for slide in result.slides)


def test_image_slideshow_is_blank(syn):
    db, idx = syn
    result = parse_item_translation(db, "image001", idx)
    assert result is not None
    assert result.slides == [""]


def test_blank_title_item_is_blank(syn):
    db, idx = syn
    result = parse_item_translation(db, "blank001", idx)
    assert result is not None
    assert result.slides == [""]


def test_source_slides_are_english(syn):
    db, idx = syn
    result = parse_item_translation(db, "song001", idx)
    assert result is not None
    assert result.sourceSlides is not None
    assert any("verse one" in s.lower() for s in result.sourceSlides), result.sourceSlides


def test_stored_translation_is_french(syn):
    db, idx = syn
    result = parse_item_translation(db, "song001", idx)
    assert result is not None
    assert result.storedTranslation is not None
    assert any("Ligne" in s or "Refrain" in s for s in result.storedTranslation), result.storedTranslation


def test_slides_equals_stored_translation_when_present(syn):
    db, idx = syn
    result = parse_item_translation(db, "song001", idx)
    assert result is not None
    assert result.slides == result.storedTranslation


def test_bible_has_source_slides_no_stored_translation(syn):
    db, idx = syn
    result = parse_item_translation(db, "bible001", idx)
    assert result is not None
    assert result.sourceSlides is not None
    assert result.storedTranslation is None
    assert result.slides == result.sourceSlides


def test_no_translation_screen_returns_source(syn):
    """parse_item_translation with translation_idx=None populates only sourceSlides."""
    db, _ = syn
    result = parse_item_translation(db, "content001", None)
    assert result is not None
    assert result.storedTranslation is None
    assert result.sourceSlides is not None
    assert result.slides == result.sourceSlides


# ---------------------------------------------------------------------------
# Expected-output comparison — run on any snapshot that has an .expected.json
# ---------------------------------------------------------------------------


def test_matches_expected(
    snapshot: dict,
    db: MockProclaimDB,
    translation_idx: Optional[int],
    expected: Optional[dict],
) -> None:
    """Full parse output must match the approved .expected.json file.

    Run ``uv run tests/update_expected.py --force`` to regenerate expected files
    after an intentional change.
    """
    if expected is None:
        pytest.skip("no .expected.json for this snapshot")
    assert translation_idx is not None

    from tests.update_expected import build_expected

    actual = build_expected(snapshot)
    assert actual == expected, (
        "Parse output differs from expected. "
        "If this is intentional, run: uv run tests/update_expected.py --force"
    )
