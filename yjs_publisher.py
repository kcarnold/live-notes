"""Client-facing consumer: publishes a FeedSnapshot into the Yjs maps browsers read.

``YjsSlidePublisher`` owns the Yjs write shape and applies each snapshot in a **single
transaction** — service order, presentations, and the status pointer land together, so a
viewer never observes a half-applied state where the slide index points past the slides
(issue #67). Per-item write-diffing (keyed on ``slides_hash``) keeps unchanged presentations
from being rewritten, so Yjs update churn stays low.

The Doc is injected via ``bind`` (on connect and on doc rollover); ``bind`` also clears the
diff state so the next ``apply`` re-pushes the full current state onto the fresh connection.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

from pycrdt import Doc, Map

from proclaim_lib import is_blank_item
from slide_feed import FeedSnapshot

logger = logging.getLogger(__name__)


class YjsSlidePublisher:
    def __init__(self) -> None:
        self.ydoc: Optional[Doc] = None

    def bind(self, doc: Doc) -> None:
        """(Re)acquire the shared maps and reset diff state so the next apply re-pushes all."""
        self.ydoc = doc
        self.service_order_map = doc.get('proclaimServiceOrder', type=Map)
        self.presentations_map = doc.get('proclaimPresentations', type=Map)
        self.status_map = doc.get('proclaimStatus', type=Map)
        self._written_hashes: Dict[str, str] = {}
        self._written_order: Optional[List[str]] = None
        self._last_item_id: Optional[str] = None
        self._last_slide_index: Optional[int] = None

    def apply(self, snap: FeedSnapshot) -> None:
        """Write order + changed presentations + clipped status in one transaction."""
        assert self.ydoc is not None, "apply() before bind()"
        with self.ydoc.transaction():
            self._apply_order(snap)
            self._apply_presentations(snap)
            self._apply_status(snap)

    def _apply_order(self, snap: FeedSnapshot) -> None:
        if snap.order != self._written_order:
            self.service_order_map['order'] = list(snap.order)
            self._written_order = list(snap.order)

    def _apply_presentations(self, snap: FeedSnapshot) -> None:
        for item_id, item in snap.items.items():
            if self._written_hashes.get(item_id) == item.slides_hash:
                continue
            self.presentations_map[item_id] = {
                'title': item.title,
                'itemId': item.item_id,
                'slides': list(item.slides),
                'itemKind': item.item_kind,
                'slidesHash': item.slides_hash,
            }
            self._written_hashes[item_id] = item.slides_hash
            logger.info(
                f"Published item {item_id} ({item.title}) with {len(item.slides)} slides"
            )

    def _apply_status(self, snap: FeedSnapshot) -> None:
        item_id = snap.active_item_id
        slide_index = self._clip(snap, item_id, snap.active_slide_index or 0)
        if item_id != self._last_item_id or slide_index != self._last_slide_index:
            self.status_map['itemId'] = item_id
            self.status_map['slideIndex'] = slide_index
            self._last_item_id = item_id
            self._last_slide_index = slide_index
            logger.info(f"Published status: {item_id} slide {slide_index}")

    def _clip(self, snap: FeedSnapshot, item_id: Optional[str], slide_index: int) -> int:
        """Clip the slide index into the active item's range (when the item is known).

        Blank items (image slideshows, offering, etc.) collapse to a single blank slide, but
        the source keeps reporting the slideshow's own advancing index as it loops. Clipping
        pins those to 0 — and since ``_apply_status`` diffs the *clipped* index, the looping
        produces no Yjs writes at all. Log it at debug for blank items so a slideshow doesn't
        emit a warning every poll cycle.
        """
        item = snap.items.get(item_id) if item_id else None
        if item is None:
            return slide_index
        clip_log = logger.debug if is_blank_item(item.item_kind, item.title) else logger.warning
        max_index = len(item.slides) - 1
        if slide_index > max_index:
            clip_log(
                f"Slide index {slide_index} out of range for item {item_id}, clipping to {max_index}"
            )
            slide_index = max_index
        if slide_index < 0:
            clip_log(f"Slide index {slide_index} less than 0 for item {item_id}, clipping to 0")
            slide_index = 0
        return slide_index
