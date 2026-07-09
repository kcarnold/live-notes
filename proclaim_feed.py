"""Proclaim slide source: the first ``SlideFeed`` implementation.

``ProclaimClient`` talks to Proclaim's local HTTP API; ``ProclaimFeed`` wraps it plus the
SQLite DB and the parsing helpers in ``proclaim_lib`` to produce a ``FeedSnapshot`` each
poll. The feed owns everything Proclaim-specific — the on-air check, the parse/revision
cache, the order-sync throttle, the show-date read, and the existing-translation grounding —
so its consumers (the Yjs publisher, the translation worker) never touch Proclaim.

This module is import-clean: no env is read and no telemetry is configured at import time.
Configuration and error reporting are injected by the entrypoint.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any, Callable, Dict, List, Optional

import anyio
import httpx

from proclaim_lib import (
    ProclaimDB,
    existing_translation_text,
    get_translation_screen_idx,
    parse_item_original,
    service_item_signatures,
    slides_hash,
)
from slide_feed import FeedItem, FeedSnapshot, SessionInfo

logger = logging.getLogger(__name__)

DEFAULT_PROCLAIM_BASE_URL = 'http://127.0.0.1:52195'


class ProclaimClient:
    """Client for Proclaim's local HTTP API."""

    def __init__(self, base_url: str = DEFAULT_PROCLAIM_BASE_URL):
        self.base_url = base_url
        self.session_id: Optional[str] = None
        self.http_client = httpx.AsyncClient()

    async def get_session_id(self, timeout: float = 2.0) -> str:
        """Request /onair/session and return the session id."""
        url = f"{self.base_url}/onair/session"
        r = await self.http_client.get(url, timeout=timeout)
        r.raise_for_status()
        self.session_id = r.content.decode('utf-8-sig')
        return self.session_id

    async def get_onair_presentation(self, timeout: float = 5.0) -> Dict[str, Any]:
        """Fetch /presentations/onair with the OnAirSessionId header."""
        await self.get_session_id()
        assert self.session_id is not None

        url = f"{self.base_url}/presentations/onair"
        headers = {'OnAirSessionId': self.session_id}
        r = await self.http_client.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        return r.json()

    async def get_status(self, timeout: float = 5.0) -> Dict[str, Any]:
        """Fetch /onair/statusChanged with the OnAirSessionId header."""
        await self.get_session_id()
        assert self.session_id is not None

        url = f"{self.base_url}/onair/statusChanged"
        headers = {'OnAirSessionId': self.session_id}
        r = await self.http_client.get(url, headers=headers, timeout=timeout)
        # 404 just means that the presentation is off air, so return empty status instead of raising
        if r.status_code == 404:
            logging.info("Presentation is currently off air")
            return {}
        r.raise_for_status()
        status = r.json()
        logger.debug(f"Proclaim status: {status}")
        return status


class ProclaimFeed:
    """A ``SlideFeed`` backed by Proclaim's HTTP API + SQLite DB.

    ``poll`` never raises on a source problem (an unreachable/off-air Proclaim yields an
    off-air snapshot). Items are re-parsed only when their Proclaim ``localRevision``
    signature changes; ``existing_translation`` grounding is stamped onto each item at
    parse time so downstream consumers (and, later, a replay feed) need no DB access.
    """

    def __init__(
        self,
        *,
        proclaim_base_url: str = DEFAULT_PROCLAIM_BASE_URL,
        db: Optional[ProclaimDB] = None,
        order_sync_interval: float = 2.0,
        report_exception: Optional[Callable[[Exception], None]] = None,
    ):
        self.client = ProclaimClient(proclaim_base_url)
        self.db = db if db is not None else ProclaimDB()
        self.order_sync_interval = order_sync_interval
        self._report_exception = report_exception or (lambda _e: None)
        self._seq = 0
        self.reset()

    @property
    def base_url(self) -> str:
        return self.client.base_url

    def reset(self) -> None:
        """Drop all source-side caches (called on doc rollover)."""
        self._items: Dict[str, FeedItem] = {}
        self._item_revisions: Dict[str, str] = {}
        self._order: List[str] = []
        self._last_order_sync = float('-inf')
        self._presentation_id: Optional[str] = None
        self._session: Optional[SessionInfo] = None
        self._session_pres_id: Optional[str] = None
        self._translation_screen_pres_id: Optional[str] = None
        self._translation_screen_idx: Optional[int] = None
        logger.debug("ProclaimFeed caches reset")

    # -- polling ---------------------------------------------------------------

    async def poll(self) -> FeedSnapshot:
        """Return a complete snapshot of Proclaim's current state (never raises on source errors)."""
        self._seq += 1
        status = await self._fetch_status()
        if status is None:
            # Off air / unreachable: keep the last-known order+items (cheap references) so a
            # brief off-air blip doesn't blank anything, but report no active pointer.
            return FeedSnapshot(
                on_air=False,
                session=self._session,
                order=list(self._order),
                items=dict(self._items),
                active_item_id=None,
                active_slide_index=None,
                seq=self._seq,
            )

        self._presentation_id = status.get('presentationId') or self._presentation_id
        self._update_session(self._presentation_id)

        active_item = status.get('status', {}).get('itemId')
        slide_index = status.get('status', {}).get('slideIndex') or 0

        # Refresh the full service order periodically, or immediately when the active item
        # isn't cached yet (e.g. right after a fresh session starts).
        now = anyio.current_time()
        if (
            now - self._last_order_sync >= self.order_sync_interval
            or (active_item and active_item not in self._items)
        ):
            presentation = await self._fetch_onair_presentation()
            if presentation:
                self._sync_order(presentation)
            self._last_order_sync = now

        return FeedSnapshot(
            on_air=True,
            session=self._session,
            order=list(self._order),
            items=dict(self._items),
            active_item_id=active_item,
            active_slide_index=slide_index,
            seq=self._seq,
        )

    async def _fetch_status(self) -> Optional[Dict[str, Any]]:
        """Fetch current Proclaim status, or None when off air / unreachable.

        Expected connectivity hiccups are swallowed (return None); they never raise, so a
        Proclaim blip can't propagate into the runtime's connection handling.
        """
        try:
            status = await self.client.get_status()
            return status or None
        except httpx.ConnectError:
            logger.debug("Proclaim not reachable (not running?)")
            return None
        except httpx.HTTPError as e:
            logger.error(f"Error polling Proclaim: {e}")
            self._report_exception(e)
            return None

    async def _fetch_onair_presentation(self) -> Optional[Dict[str, Any]]:
        """Fetch the full on-air service order, or None on failure (swallowed like status)."""
        try:
            return await self.client.get_onair_presentation()
        except httpx.HTTPError as e:
            logger.warning(f"Could not fetch on-air presentation: {e}")
            return None

    # -- order sync / parsing --------------------------------------------------

    def _sync_order(self, presentation: Dict[str, Any]) -> None:
        """Update the cached order + items from the on-air presentation.

        Only items whose Proclaim ``localRevision`` signature changed (or that we haven't
        seen) are re-read from the DB; a DB/parse error for one item is logged and skipped
        (its revision is left uncached so we retry next sync) rather than dropping the order.
        """
        signatures = service_item_signatures(presentation)
        self._order = [sig['id'] for sig in signatures if sig['id']]

        for sig in signatures:
            item_id = sig['id']
            if not item_id:
                continue
            unchanged = (
                self._item_revisions.get(item_id) == sig['revision']
                and item_id in self._items
            )
            if unchanged:
                continue

            try:
                parsed = parse_item_original(self.db, item_id)
            except Exception as e:
                logger.warning(f"Failed to parse item {item_id} from Proclaim DB: {e}; will retry")
                continue
            if not parsed:
                continue

            self._items[item_id] = self._to_feed_item(parsed)
            self._item_revisions[item_id] = sig['revision']
            logger.info(
                f"Synced item {item_id} ({parsed.title}) with {len(parsed.slides)} original slides"
            )

    def _to_feed_item(self, parsed) -> FeedItem:
        """Convert a parsed ServiceItemWithSlides into a FeedItem with hash + grounding."""
        return FeedItem(
            item_id=parsed.itemId,
            title=parsed.title,
            slides=parsed.slides,
            item_kind=parsed.itemKind,
            slides_hash=slides_hash(parsed.slides),
            existing_translation=self._existing_translation_for(parsed.itemId),
        )

    def _existing_translation_for(self, item_id: str) -> Optional[str]:
        """Proclaim's own translation-screen text for an item, joined, or None.

        The translation-screen index is a presentation-level property, computed once per
        presentation and cached. Best-effort: any DB/parse problem yields None.
        """
        presentation_id = self._presentation_id
        if not presentation_id:
            return None
        try:
            if self._translation_screen_pres_id != presentation_id:
                presentation = self.db.get_presentation(presentation_id)
                content = presentation.get('content') if presentation else None
                self._translation_screen_idx = (
                    get_translation_screen_idx(content) if content else None
                )
                self._translation_screen_pres_id = presentation_id
            if self._translation_screen_idx is None:
                return None
            return existing_translation_text(self.db, item_id, self._translation_screen_idx)
        except Exception as e:
            logger.debug(f"No existing translation for {item_id}: {e}")
            return None

    # -- session date ----------------------------------------------------------

    def _update_session(self, presentation_id: Optional[str]) -> None:
        """Refresh the cached SessionInfo when the on-air presentation changes."""
        if presentation_id == self._session_pres_id and self._session is not None:
            return
        show_date = self._read_show_date(presentation_id)
        self._session = SessionInfo(presentation_id=presentation_id, session_date=show_date)
        self._session_pres_id = presentation_id

    def _read_show_date(self, presentation_id: Optional[str]) -> Optional[date]:
        """Read the on-air presentation's DateGiven as a date, or None if unavailable."""
        if not presentation_id:
            return None
        try:
            pres = self.db.get_presentation(presentation_id)
        except Exception as e:
            logger.warning(f"Could not read date for presentation {presentation_id}: {e}")
            return None
        if not pres:
            return None
        return self._parse_date_given(pres.get('date_given'))

    @staticmethod
    def _parse_date_given(raw: Any) -> Optional[date]:
        """Parse a Proclaim ``DateGiven`` value (e.g. ``"2025-03-02"``) into a date, or None."""
        if not isinstance(raw, str):
            return None
        # DateGiven is a date string but tolerate an accidental time component.
        token = raw.strip().replace('T', ' ').split(' ')[0]
        try:
            return date.fromisoformat(token)
        except ValueError:
            return None
