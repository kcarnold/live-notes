"""
Shared library for interacting with Proclaim presentation data.

Provides:
- Database discovery and access (PresentationManager.db)
- Rich text XML decoding
- Slide/section parsing and ordering
- Translation screen detection
- Service item parsing
"""

import hashlib
import json
import logging
import sqlite3
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Main/original-language content keys per item kind (the non-translation screen).
MAIN_CONTENT_KEYS = {
    'SongLyrics': '_richtextfield:Lyrics',
    'Content': '_richtextfield:Main Content',
    'BiblePassage': '_richtextfield:Passage',
}

# Item kinds / titles that render as a blank slide (no translatable text).
# 'Grouping' is an image-slideshow grouping container - no translatable text.
BLANK_ITEM_KINDS = ['ImageSlideshow', 'Grouping']
BLANK_ITEM_TITLES = ['blank', 'ncf slide', 'offering slide']

from lxml import etree

logger = logging.getLogger(__name__)


@dataclass
class ServiceItemWithSlides:
    itemId: str
    title: str
    slides: List[str]
    itemKind: str


def find_presentation_db() -> str:
    """Find the most recently modified Proclaim presentation database file."""
    if (path := Path.home() / 'Library' / 'Application Support' / 'Proclaim' / 'Data').exists():
        proclaim_root = path
    elif (path := Path.home() / 'AppData' / 'Local' / 'Proclaim' / 'Data').exists():
        proclaim_root = path
    else:
        raise FileNotFoundError('Proclaim data directory not found.')

    db_files = list(proclaim_root.glob('*/PresentationManager/PresentationManager.db'))
    if not db_files:
        raise FileNotFoundError('No PresentationManager.db files found.')

    return str(max(db_files, key=lambda p: p.stat().st_mtime))


def decode_richtext_xml(xml: str) -> str:
    """
    Decode the rich text XML from Proclaim into plain text.

    The basic XML format is:
    <Paragraph Language="en-US" Margin="0,0,0,0">
        <Run Text="I love You Lord" />
    </Paragraph>
    """
    result = ''
    root = etree.fromstring('<Song>' + xml + '</Song>', parser=None)
    for paragraph in root:
        runs = paragraph.findall('Run')
        for run in runs:
            result += run.attrib['Text'] + ' '
        result += '\n'
    return result


def split_into_slides(text: str) -> List[str]:
    """Split the text into sections based on blank lines or --."""
    lines = text.strip().splitlines()
    explicitly_delimited = any(line.strip() == '--' for line in lines)
    sections = ['']
    for line in lines:
        line_stripped = line.strip()
        is_slide_break = (line_stripped == '' and not explicitly_delimited) or (line_stripped == '--')
        if is_slide_break:
            sections.append('')
        else:
            sections[-1] += line + '\n'

    return [
        section.strip()
        for section in sections
        if section.strip() != ''
        and not (section.startswith('{Credits}') or section.startswith('{Source}'))
    ]


def split_into_song_sections(text: str) -> Dict[str, List[str]]:
    """
    Split the song text into labeled sections.
    A blank line followed by a section type marks a section:
    Verse, Chorus, Pre-chorus, Bridge, Tag, Title, Interlude
    """
    sections: Dict[str, List[str]] = {}
    current_section_label = None
    section_types = {'verse', 'chorus', 'pre-chorus', 'bridge', 'tag', 'title', 'interlude', 'vamp', 'ending'}
    lines = [line.strip() for line in text.splitlines()]

    for line_orig in lines:
        line = line_orig.lower()
        if any(line.startswith(st) for st in section_types):
            if not any(char.isdigit() for char in line):
                line += ' 1'
            current_section_label = line
        elif line.startswith('{') and line.endswith('}'):
            current_section_label = line[1:-1].strip()
        else:
            sections.setdefault(current_section_label, []).append(line_orig)

    return {
        label: split_into_slides('\n'.join(lines))
        for label, lines in sections.items()
    }


def get_slides_in_order(slide_sections: Dict[str, List[str]], order_str: str) -> List[str]:
    """Decode the CustomOrderSequence string into the slides in order."""
    slides = []

    if order_str.strip() == '':
        for section in slide_sections.values():
            slides.extend(section)
        return slides

    for token in order_str.split(','):
        token = token.strip()

        trailing_number = ''
        while token and token[-1].isdigit():
            trailing_number = token[-1] + trailing_number
            token = token[:-1]
        token = token.strip()
        lower_token = token.lower()

        if token == '':
            assert trailing_number
            label = f"Verse {trailing_number}"
        elif lower_token in ('v', 'verse'):
            label = f"Verse {trailing_number or '1'}"
        elif lower_token in ('c', 'chorus'):
            label = f"Chorus {trailing_number or '1'}"
        elif lower_token in ('p', 'pre-chorus'):
            label = f"Pre-chorus {trailing_number or '1'}"
        elif lower_token == 'b':
            possible_label = f"Bridge {trailing_number or '1'}"
            if possible_label.lower() in slide_sections:
                label = possible_label
            else:
                label = "Blank"
        elif lower_token == 'bridge':
            label = f"Bridge {trailing_number or '1'}"
        elif lower_token in ('t', 'tag'):
            label = f"Tag {trailing_number or '1'}"
        elif lower_token == 'i':
            label = f"Interlude {trailing_number or '1'}"
        elif lower_token == 'ending':
            label = f"Ending {trailing_number or '1'}"
        else:
            label = token

        if label == 'Blank':
            slides.append('')
        elif label.lower() in slide_sections:
            slides.extend(slide_sections[label.lower()])
        else:
            logger.warning(f"Label '{label}' ({token}) not found in slide sections.")

    return slides


def get_translation_screen_idx(presentation_content: dict) -> Optional[int]:
    """Get the index of the translation screen from VirtualScreens."""
    virtual_screens = json.loads(presentation_content.get('VirtualScreens') or '[]')
    slide_screens = [s for s in virtual_screens if s['outputKind'] in ['Slides', 'SlidesAlternateContent']]

    for idx, screen in enumerate(slide_screens):
        if any(lang in screen['name'] for lang in ['French', 'Haitian']):
            return idx

    return None


def get_slide_screen_indices(presentation_content: dict) -> tuple:
    """Get greenscreen and translation screen indices.

    Returns (greenscreen_idx_or_None, translation_idx).
    Raises ValueError if translation screen count != 1.
    """
    virtual_screens = json.loads(presentation_content.get('VirtualScreens') or '[]')
    slide_screens = [s for s in virtual_screens if s['outputKind'] in ['Slides', 'SlidesAlternateContent']]

    greenscreen_idx = next(
        (i for i, screen in enumerate(slide_screens) if screen['name'] == 'Green Screen'),
        None
    )

    translation_indices = [
        i for i, screen in enumerate(slide_screens)
        if any(lang in screen['name'] for lang in ['French', 'Haitian'])
    ]
    if len(translation_indices) != 1:
        raise ValueError(f"Expected one translation screen, found {len(translation_indices)}")

    return greenscreen_idx, translation_indices[0]


class ProclaimDB:
    """Access layer for the Proclaim PresentationManager database."""

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or find_presentation_db()

    def connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path)

    def get_service_item(self, item_id: str) -> Optional[Dict[str, Any]]:
        """Get a service item by its ID."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM ServiceItems WHERE ServiceItemId = ?", (item_id,))
            row = cursor.fetchone()
            if row is None:
                return None
            return dict(zip([col[0] for col in cursor.description], row))

    def get_presentation(self, presentation_id: str) -> Optional[Dict[str, Any]]:
        """Get presentation data from the database."""
        presentation_id = presentation_id.replace('-', '')
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT PresentationId, DateGiven, Content FROM Presentations WHERE PresentationId = ?",
                (presentation_id,)
            )
            row = cursor.fetchone()
            if row is None:
                return None
            return {
                'id': row[0],
                'date_given': row[1],
                'content': json.loads(row[2])
            }

    def get_presentations(self, limit: int = 10) -> List[Dict[str, Any]]:
        """Get recent presentations."""
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                '''
                SELECT PresentationId, DateGiven, Title, Content
                FROM Presentations
                WHERE DateGiven > "2024-01-01" AND Title NOT LIKE "INCORRECT%"
                ORDER BY DateGiven DESC
                LIMIT ?
                ''', (limit,)
            ).fetchall()

        return [
            {
                'id': row[0],
                'date_given': row[1],
                'title': row[2],
                'content': json.loads(row[3])
            }
            for row in rows
        ]


def get_slides_for_song(content: dict, content_key: str = '_richtextfield:Lyrics') -> List[str]:
    """Get the slides for a song item."""
    text = decode_richtext_xml(content[content_key])
    return split_into_slides(text)


def is_blank_item(item_kind: str, item_title: str) -> bool:
    """Whether an item renders as a blank slide (image slideshow, offering, etc.)."""
    return item_kind in BLANK_ITEM_KINDS or item_title.lower() in BLANK_ITEM_TITLES


def _slides_from_source_xml(item_kind: str, content: dict, source_xml: str) -> List[str]:
    """Decode and split a rich-text source field into ordered slides for an item.

    Songs are split into labeled sections and ordered by CustomOrderSequence; other
    kinds split on blank lines / explicit ``--`` delimiters.
    """
    source_text = decode_richtext_xml(source_xml)

    if item_kind == 'SongLyrics':
        sections = split_into_song_sections(source_text)
        order_str = content.get('CustomOrderSequence') or ''
        slides = get_slides_in_order(sections, order_str)
        if title := content.get('SongDisplayTitle'):
            slides.insert(0, title)
        return slides

    return split_into_slides(source_text)


def parse_item_translation(
    db: ProclaimDB,
    item_id: str,
    translation_screen_idx: int,
) -> Optional[ServiceItemWithSlides]:
    """Extract translated slides for any item type."""
    service_item = db.get_service_item(item_id.replace('-', ''))
    if not service_item:
        logger.warning(f"Service item {item_id} not found")
        return None

    content = json.loads(service_item['Content'])
    item_kind = service_item.get('ServiceItemKind') or 'Unknown'
    item_title = service_item.get('Title') or 'Unknown'

    if is_blank_item(item_kind, item_title):
        logger.info(f"Showing blank item: {item_title}")
        return ServiceItemWithSlides(itemId=item_id, title=item_title, slides=[''], itemKind=item_kind)

    translation_key = f'slideOutput:{translation_screen_idx-1}:RichTextXml'

    # Try translation first, fall back to main content
    if translation_key in content:
        source_xml = content[translation_key]
    else:
        fallback_key = MAIN_CONTENT_KEYS.get(item_kind)
        if fallback_key and fallback_key in content:
            logger.warning(f"No translation for {item_id}, falling back to main content")
            source_xml = content[fallback_key]
        else:
            logger.warning(f"No translation or main content found for {item_id}")
            return None

    slides = _slides_from_source_xml(item_kind, content, source_xml)
    return ServiceItemWithSlides(itemId=item_id, title=item_title, slides=slides, itemKind=item_kind)


def parse_item_original(db: ProclaimDB, item_id: str) -> Optional[ServiceItemWithSlides]:
    """Extract the original/main-language slides for an item (the source for translation).

    Unlike ``parse_item_translation``, this always reads the Main screen content, so
    the slides are the original-language text the LLM/library translate *from*.
    """
    service_item = db.get_service_item(item_id.replace('-', ''))
    if not service_item:
        logger.warning(f"Service item {item_id} not found")
        return None

    content = json.loads(service_item['Content'])
    item_kind = service_item.get('ServiceItemKind') or 'Unknown'
    item_title = service_item.get('Title') or 'Unknown'

    if is_blank_item(item_kind, item_title):
        return ServiceItemWithSlides(itemId=item_id, title=item_title, slides=[''], itemKind=item_kind)

    main_key = MAIN_CONTENT_KEYS.get(item_kind)
    if not main_key or main_key not in content:
        logger.warning(f"No main content found for {item_id} (kind {item_kind})")
        return None

    slides = _slides_from_source_xml(item_kind, content, content[main_key])
    return ServiceItemWithSlides(itemId=item_id, title=item_title, slides=slides, itemKind=item_kind)


def normalize_slide_text(text: str) -> str:
    """Canonicalize slide text for use as a translation key.

    Must match the TypeScript ``normalizeSlideText`` exactly so keys written by this
    service line up with what the frontend reads: NFC, LF line endings, trailing
    whitespace stripped per line, surrounding blank lines trimmed, internal line
    breaks preserved.
    """
    text = unicodedata.normalize('NFC', text)
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    lines = [line.rstrip() for line in text.split('\n')]
    return '\n'.join(lines).strip()


def slide_translation_key(language: str, slide_text: str) -> str:
    """Content-addressed key combining language and normalized slide text."""
    return f"{language}:{normalize_slide_text(slide_text)}"


def existing_translation_text(
    db: ProclaimDB,
    item_id: str,
    translation_screen_idx: int,
) -> Optional[str]:
    """Return the decoded text of an item's existing translation screen, or None.

    Unlike ``parse_item_translation`` this does NOT fall back to the Main screen: if the
    item has no translation-screen field we return None (so we never feed the original
    language back as a "translation" reference). The text is returned joined, unsegmented
    — the LLM re-aligns it to the source slides.
    """
    service_item = db.get_service_item(item_id.replace('-', ''))
    if not service_item:
        return None

    content = json.loads(service_item['Content'])
    item_kind = service_item.get('ServiceItemKind') or 'Unknown'
    item_title = service_item.get('Title') or 'Unknown'
    if is_blank_item(item_kind, item_title):
        return None

    translation_key = f'slideOutput:{translation_screen_idx-1}:RichTextXml'
    if translation_key not in content:
        return None

    slides = _slides_from_source_xml(item_kind, content, content[translation_key])
    text = '\n\n'.join(slide for slide in slides if slide.strip())
    return text or None


def slides_hash(slides: List[str]) -> str:
    """Stable content hash of an item's slides, for detecting changes underneath us."""
    digest = hashlib.sha256()
    for slide in slides:
        digest.update(slide.encode('utf-8'))
        digest.update(b'\x00')
    return digest.hexdigest()


def service_item_signatures(onair_presentation: dict) -> List[Dict[str, str]]:
    """Summarize the on-air service order with a per-item change signature.

    The signature combines the per-slide ``localRevision`` values Proclaim reports,
    so we can tell when an item's content changed without re-reading the DB.
    """
    items: List[Dict[str, str]] = []
    for item in onair_presentation.get('serviceItems', []):
        slides = item.get('slides', []) or []
        revision = '|'.join(str(slide.get('localRevision', '')) for slide in slides)
        items.append({
            'id': item.get('id', ''),
            'title': item.get('title', ''),
            'kind': item.get('kind', ''),
            'revision': revision,
        })
    return items


def build_seed_pairs(
    original_slides: List[str],
    translation_slides: List[str],
) -> Optional[List[Tuple[str, str]]]:
    """Align an item's original and existing-translation slides into pairs to seed the
    reviewed library, or None when they can't be aligned 1:1 (different slide counts).
    """
    if not original_slides or len(original_slides) != len(translation_slides):
        return None
    pairs = [
        (orig.strip(), trans.strip())
        for orig, trans in zip(original_slides, translation_slides)
        if orig.strip() and trans.strip()
    ]
    return pairs or None
