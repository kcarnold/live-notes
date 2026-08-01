"""Translation consumer: pre-translates upcoming slides off the poll loop.

``SlideTranslator`` runs as a background task, reading the *latest* snapshot from a
``SnapshotBus`` and translating the first item (active item first) whose current content
still has a cache miss. It reads the order, active item, and existing-translation grounding
from the **snapshot** — not from the Yjs sink — which removes the old coupling where the
worker read state back out of the maps it was feeding.

It does, however, read *and* write the live ``slideTranslations`` map: cache-miss detection
must see ``reviewed`` entries that the frontend review screen writes there, and its own
seeding must never clobber them. Each content version is attempted once (tracked by slides
hash) so a failed/partial translation doesn't spin.

The actual translation call is injected (``translate_fn``) so the source of translations
(the server's ``/api/translateItem`` in production, a fake in tests) is swappable.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional

from pycrdt import Doc, Map

from proclaim_lib import slide_translation_key
from slide_feed import FeedItem, FeedSnapshot, SnapshotBus

logger = logging.getLogger(__name__)

# (slides, item_title, item_id, existing_translation, doc_id)
#   -> {language: [{text, status, provenance}]}
# doc_id names the doc this session is bound to, so the server can write the agent
# conversation into the same per-day doc. It arrives via bind() rather than being closed over
# at construction, because a date rollover swaps the doc underneath a long-lived translator.
TranslateFn = Callable[
    [List[str], Optional[str], Optional[str], Optional[str], Optional[str]],
    Awaitable[Optional[Dict[str, Any]]],
]


class SlideTranslator:
    def __init__(
        self,
        translate_fn: TranslateFn,
        languages: List[str],
        scan_interval: float,
        report_exception: Optional[Callable[[Exception], None]] = None,
    ):
        self.translate_fn = translate_fn
        self.languages = languages
        self.scan_interval = scan_interval
        self._report_exception = report_exception or (lambda _e: None)
        self.ydoc: Optional[Doc] = None
        self.doc_id: Optional[str] = None

    def bind(self, doc: Doc, doc_id: Optional[str] = None) -> None:
        """(Re)acquire the slideTranslations map and reset the attempted-content cache."""
        self.ydoc = doc
        self.doc_id = doc_id
        self.translations_map = doc.get('slideTranslations', type=Map)
        self._translated_hashes: Dict[str, str] = {}

    async def run(self, bus: SnapshotBus) -> None:
        """Background loop: translate pending items back-to-back, then idle until a new snapshot.

        Runs for the life of a session. Errors are reported but never end the loop.
        """
        while True:
            snap = bus.current
            try:
                did_work = await self._translate_pending(snap) if snap else False
            except Exception as e:  # best-effort: never let a translation kill the worker
                logger.warning(f"Translation worker error: {e}")
                self._report_exception(e)
                did_work = False
            if did_work:
                continue
            await bus.wait(self.scan_interval)

    async def _translate_pending(self, snap: FeedSnapshot) -> bool:
        """Translate one item that still has missing translations, if any.

        Returns True if it did a unit of work (caller re-scans immediately), False when
        everything reachable is already covered.
        """
        for item_id in self._scan_order(snap):
            item = snap.items.get(item_id)
            if not item or not item.slides:
                continue
            if self._translated_hashes.get(item_id) == item.slides_hash:
                continue  # already handled this content version
            if not self._has_missing_translation(item):
                # Fully covered already (e.g. warm-started from the library) — mark and skip.
                self._translated_hashes[item_id] = item.slides_hash
                continue

            translations = await self.translate_fn(
                item.slides, item.title, item.item_id, item.existing_translation, self.doc_id
            )
            # Mark attempted even on failure so we don't hammer the same content; a real
            # content change produces a new hash and another attempt.
            self._translated_hashes[item_id] = item.slides_hash
            if translations:
                self._store_translations(item.slides, translations)
                logger.info(f"Translated item {item_id} ({item.title})")
            return True
        return False

    def _scan_order(self, snap: FeedSnapshot) -> List[str]:
        """Item ids to consider, active item first, then upcoming, then past."""
        order = list(snap.order)
        active = snap.active_item_id
        if active and active in order:
            i = order.index(active)
            return order[i:] + order[:i]
        return order

    def _has_missing_translation(self, item: FeedItem) -> bool:
        """True if any non-empty slide lacks a translation in any target language.

        Reads the live map (not the snapshot) so reviewed entries written by the frontend
        count as present.
        """
        for language in self.languages:
            for slide in item.slides:
                if not slide.strip():
                    continue
                if slide_translation_key(language, slide) not in self.translations_map:
                    return True
        return False

    def _store_translations(self, slides: List[str], translations: Dict[str, Any]) -> None:
        """Seed per-slide results into slideTranslations, never clobbering reviewed entries."""
        assert self.ydoc is not None, "_store_translations before bind()"
        with self.ydoc.transaction():
            for language, per_slide in translations.items():
                for slide, entry in zip(slides, per_slide):
                    if not slide.strip() or not entry:
                        continue
                    key = slide_translation_key(language, slide)
                    existing = self.translations_map[key] if key in self.translations_map else None
                    if existing is not None and existing.get('status') == 'reviewed':
                        continue
                    self.translations_map[key] = {
                        'text': entry.get('text', ''),
                        'status': entry.get('status', 'auto'),
                        'provenance': entry.get('provenance', 'llm'),
                    }
