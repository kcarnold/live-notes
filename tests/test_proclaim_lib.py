"""Tests for the pure parsing/change-detection helpers in proclaim_lib.

These need no real Proclaim DB: a tiny fake stands in for ProclaimDB.get_service_item.
"""

import json
import unicodedata

from proclaim_lib import (
    parse_item_original,
    parse_item_translation,
    existing_translation_text,
    slides_hash,
    service_item_signatures,
    build_seed_pairs,
    normalize_slide_text,
    slide_translation_key,
)


def richtext(lines):
    """Build a Proclaim rich-text XML fragment: one <Paragraph> per line."""
    parts = []
    for line in lines:
        if line == '':
            parts.append('<Paragraph Language="en-US" Margin="0,0,0,0" />')
        else:
            parts.append(
                f'<Paragraph Language="en-US" Margin="0,0,0,0"><Run Text="{line}" /></Paragraph>'
            )
    return ''.join(parts)


class FakeDB:
    """Maps de-hyphenated service item id -> a ServiceItems row dict."""

    def __init__(self, items):
        self.items = items

    def get_service_item(self, item_id):
        return self.items.get(item_id)


def content_item(main_lines=None, translation_lines=None, kind='Content', title='Call to Worship'):
    content = {}
    if main_lines is not None:
        content['_richtextfield:Main Content'] = richtext(main_lines)
    if translation_lines is not None:
        content['slideOutput:0:RichTextXml'] = richtext(translation_lines)
    return {'ServiceItemKind': kind, 'Title': title, 'Content': json.dumps(content)}


def test_parse_item_original_splits_main_content_on_delimiters():
    db = FakeDB({'item1': content_item(main_lines=['Slide one', '--', 'Slide two'])})
    item = parse_item_original(db, 'item1')
    assert item is not None
    assert item.slides == ['Slide one', 'Slide two']
    assert item.itemKind == 'Content'


def test_parse_item_original_blank_for_image_slideshow():
    db = FakeDB({'img1': content_item(kind='ImageSlideshow', title='Slideshow')})
    item = parse_item_original(db, 'img1')
    assert item is not None
    assert item.slides == ['']


def test_parse_item_original_missing_main_content_returns_none():
    db = FakeDB({'item1': content_item(translation_lines=['Diapositive un'])})
    assert parse_item_original(db, 'item1') is None


def test_parse_item_original_uses_main_not_translation_screen():
    db = FakeDB({
        'item1': content_item(
            main_lines=['English one', '--', 'English two'],
            translation_lines=['Trad un', '--', 'Trad deux'],
        )
    })
    item = parse_item_original(db, 'item1')
    assert item.slides == ['English one', 'English two']


def test_parse_item_translation_still_reads_translation_screen():
    db = FakeDB({
        'item1': content_item(
            main_lines=['English one'],
            translation_lines=['Trad un', '--', 'Trad deux'],
        )
    })
    item = parse_item_translation(db, 'item1', translation_screen_idx=1)
    assert item.slides == ['Trad un', 'Trad deux']


def test_existing_translation_text_joins_translation_screen():
    db = FakeDB({
        'item1': content_item(
            main_lines=['English one'],
            translation_lines=['Trad un', '--', 'Trad deux'],
        )
    })
    assert existing_translation_text(db, 'item1', translation_screen_idx=1) == 'Trad un\n\nTrad deux'


def test_existing_translation_text_none_without_translation_screen():
    db = FakeDB({'item1': content_item(main_lines=['English one'])})
    assert existing_translation_text(db, 'item1', translation_screen_idx=1) is None


def test_existing_translation_text_none_for_blank_item():
    db = FakeDB({'img1': content_item(kind='ImageSlideshow', title='Slideshow')})
    assert existing_translation_text(db, 'img1', translation_screen_idx=1) is None


def test_slides_hash_is_stable_and_sensitive():
    assert slides_hash(['a', 'b']) == slides_hash(['a', 'b'])
    assert slides_hash(['a', 'b']) != slides_hash(['a', 'b', 'c'])
    # Boundary between slides matters: ['a','b'] != ['ab']
    assert slides_hash(['a', 'b']) != slides_hash(['ab'])


def test_service_item_signatures_summarizes_order_and_revisions():
    onair = {
        'serviceItems': [
            {
                'id': 'i1',
                'title': 'Call to Worship',
                'kind': 'Content',
                'slides': [{'localRevision': 111, 'index': 0}, {'localRevision': 222, 'index': 1}],
            },
            {'id': 'i2', 'title': 'Song', 'kind': 'SongLyrics', 'slides': []},
        ]
    }
    sigs = service_item_signatures(onair)
    assert [s['id'] for s in sigs] == ['i1', 'i2']
    assert sigs[0]['revision'] == '111|222'
    assert sigs[1]['revision'] == ''


def test_build_seed_pairs_aligns_equal_length_lists():
    pairs = build_seed_pairs(['Hello', 'World'], ['Bonjour', 'Monde'])
    assert pairs == [('Hello', 'Bonjour'), ('World', 'Monde')]


def test_build_seed_pairs_returns_none_on_length_mismatch():
    assert build_seed_pairs(['a', 'b'], ['x']) is None


def test_build_seed_pairs_skips_empty_pairs():
    pairs = build_seed_pairs(['Hello', ''], ['Bonjour', ''])
    assert pairs == [('Hello', 'Bonjour')]


def test_normalize_slide_text_matches_ts_behavior():
    # Surrounding blank lines trimmed, internal breaks kept.
    assert normalize_slide_text('\n\nLine one\nLine two\n\n') == 'Line one\nLine two'
    # Trailing whitespace per line stripped; CRLF normalized.
    assert normalize_slide_text('Line one  \r\nLine two\t') == 'Line one\nLine two'
    # NFC normalization: a decomposed e + combining acute accent collapses to one code point.
    decomposed = 'e' + '́'
    assert normalize_slide_text(decomposed) == unicodedata.normalize('NFC', decomposed)
    assert len(normalize_slide_text(decomposed)) == 1


def test_slide_translation_key_combines_language_and_normalized_text():
    assert slide_translation_key('French', '  Bonjour  ') == 'French:Bonjour'
    assert slide_translation_key('French', 'Bonjour\n') == slide_translation_key('French', 'Bonjour')
