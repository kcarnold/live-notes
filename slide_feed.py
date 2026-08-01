"""The slide-feed seam: the serializable boundary between a slide *source* and its consumers.

A ``SlideFeed`` produces a complete ``FeedSnapshot`` each poll cycle. The snapshot is the
whole point of the decoupling: it is self-contained (never a delta) and JSON-round-trippable,
so it can be

- fanned out to multiple consumers (the Yjs publisher, the translation worker) that each
  react to the *latest* state, and
- (later, issue #70) recorded to disk and replayed to drive the real consumers with no
  source in the loop.

This module is deliberately dependency-light and has **no import-time side effects** (no env
reads, no asserts) so it can be imported in unit tests without a configured environment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

import anyio


@dataclass(frozen=True)
class FeedItem:
    """One service item's parsed original-language slides, plus source-provided grounding.

    ``slides_hash`` is precomputed (``proclaim_lib.slides_hash``) so consumers and replay
    never recompute it. ``existing_translation`` is the source's own translation of the item
    (e.g. Proclaim's translation screen), joined and unsegmented, or None — the translation
    worker forwards it to the model as grounding. It lives on the item (rather than behind a
    live feed method) so a recorded snapshot carries everything a consumer needs.
    """

    item_id: str
    title: str
    slides: List[str]
    item_kind: str
    slides_hash: str
    existing_translation: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            'itemId': self.item_id,
            'title': self.title,
            'slides': list(self.slides),
            'itemKind': self.item_kind,
            'slidesHash': self.slides_hash,
            'existingTranslation': self.existing_translation,
        }

    @classmethod
    def from_json(cls, data: Dict[str, Any]) -> 'FeedItem':
        return cls(
            item_id=data['itemId'],
            title=data['title'],
            slides=list(data['slides']),
            item_kind=data['itemKind'],
            slides_hash=data['slidesHash'],
            existing_translation=data.get('existingTranslation'),
        )


@dataclass(frozen=True)
class SessionInfo:
    """Identity of the live session, as reported by the source.

    ``session_date`` comes from the show's scheduled date (Proclaim's ``DateGiven``) when the
    source knows it; None means the runtime should fall back to wall-clock today.
    """

    presentation_id: Optional[str] = None
    session_date: Optional[date] = None

    def to_json(self) -> Dict[str, Any]:
        return {
            'presentationId': self.presentation_id,
            'sessionDate': self.session_date.isoformat() if self.session_date else None,
        }

    @classmethod
    def from_json(cls, data: Dict[str, Any]) -> 'SessionInfo':
        raw_date = data.get('sessionDate')
        return cls(
            presentation_id=data.get('presentationId'),
            session_date=date.fromisoformat(raw_date) if raw_date else None,
        )


@dataclass(frozen=True)
class FeedSnapshot:
    """A complete, self-contained view of the source at one poll cycle.

    Always carries the *full* order + items (even on a cycle where only the status pointer
    moved), so a single-transaction publisher never blanks the order and each recorded line
    stands alone. ``seq`` is a monotonic counter for ordering on replay.
    """

    on_air: bool
    session: Optional[SessionInfo]
    order: List[str] = field(default_factory=list)
    items: Dict[str, FeedItem] = field(default_factory=dict)
    active_item_id: Optional[str] = None
    active_slide_index: Optional[int] = None
    seq: int = 0

    def to_json(self) -> Dict[str, Any]:
        return {
            'onAir': self.on_air,
            'session': self.session.to_json() if self.session else None,
            'order': list(self.order),
            'items': {item_id: item.to_json() for item_id, item in self.items.items()},
            'activeItemId': self.active_item_id,
            'activeSlideIndex': self.active_slide_index,
            'seq': self.seq,
        }

    @classmethod
    def from_json(cls, data: Dict[str, Any]) -> 'FeedSnapshot':
        session = data.get('session')
        return cls(
            on_air=data['onAir'],
            session=SessionInfo.from_json(session) if session else None,
            order=list(data.get('order', [])),
            items={
                item_id: FeedItem.from_json(item)
                for item_id, item in (data.get('items') or {}).items()
            },
            active_item_id=data.get('activeItemId'),
            active_slide_index=data.get('activeSlideIndex'),
            seq=data.get('seq', 0),
        )


@runtime_checkable
class SlideFeed(Protocol):
    """A source of slide data. Implementations own their own polling/parse/caching.

    ``poll`` must never raise on a *source* problem (an unreachable/erroring source is an
    off-air snapshot, not an exception); the runtime's error handling then only concerns the
    downstream connection.
    """

    async def poll(self) -> FeedSnapshot: ...

    def reset(self) -> None:
        """Drop all source-side caches (called on doc rollover so a new day starts clean)."""
        ...


class SnapshotBus:
    """Single-slot, conflating latest-value cell with a wake event.

    Consumers that care only about the newest snapshot (not every intermediate one) read
    ``current`` and ``await wait(...)`` to sleep until a new snapshot is published or the
    timeout elapses. Publishing is non-blocking and never backs up the poll loop.
    """

    def __init__(self) -> None:
        self._latest: Optional[FeedSnapshot] = None
        self._event = anyio.Event()

    def publish(self, snap: FeedSnapshot) -> None:
        self._latest = snap
        event, self._event = self._event, anyio.Event()
        event.set()

    @property
    def current(self) -> Optional[FeedSnapshot]:
        return self._latest

    async def wait(self, timeout: float) -> None:
        """Sleep until the next ``publish`` or ``timeout`` seconds, whichever comes first."""
        with anyio.move_on_after(timeout):
            await self._event.wait()
